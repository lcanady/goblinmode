// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./utils/Ownable.sol";
import "./utils/ReentrancyGuard.sol";
import "./GoblinBadge.sol";
import "./GoblinAccess.sol";
import "./GoblinTokenFactory.sol";
import "./GoblinToken.sol";

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IPvPRot {
    /// @notice Returns the SURVIVING fraction of progression in bps for `wallet`
    /// in the current epoch. 10000 = unaffected, 0 = fully rotted.
    function getRotMultiplierBps(address wallet) external view returns (uint256);
}

/// @title GoblinCurve
/// @notice The bonding-curve heart of goblinmode.fun. Every launched token lives here
/// against virtual USDC reserves until it crosses the graduation threshold, at which
/// point liquidity is released to an external AMM via a relayer. USDC-denominated
/// (6 decimals) because Monad's launch ecosystem treats USDC as canonical.
contract GoblinCurve is Ownable, ReentrancyGuard {
    // ----------------------------------------------------------------
    // Constants
    // ----------------------------------------------------------------
    uint256 public constant INITIAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant VIRTUAL_USDC_OFFSET = 1_000e6;
    uint256 public constant GRADUATION_THRESHOLD = 69_000e6;
    uint256 public constant DEFAULT_FEE_BPS = 100;
    uint256 public constant BPS_DENOM = 10_000;
    uint256 public constant TOP10_SIZE = 10;
    uint256 public constant GRADUATION_FEE_BPS = 200; // 2% protocol cut at graduation
    uint256 public constant CREATOR_FEE_SHARE_BPS = 2000; // 20% of trading fees to creator

    // H-6: USDC volume floors (6-dec) gating rank promotions so spam-trades alone don't promote.
    uint256 public constant TRENCH_VOLUME_FLOOR = 100e6;          // 100 USDC
    uint256 public constant CURSED_HUNTER_VOLUME_FLOOR = 500e6;   // 500 USDC
    uint256 public constant VETERAN_VOLUME_FLOOR = 5_000e6;       // 5,000 USDC

    // M-1: minimum interval between consecutive score updates per token.
    uint256 public constant SCORE_COOLDOWN = 1 hours;

    // ----------------------------------------------------------------
    // Types
    // ----------------------------------------------------------------
    enum Label { NEUTRAL, BLESSED, CURSED }

    struct TokenState {
        address token;
        address creator;
        string metadataURI;
        uint256 virtualUSDC;        // reserves used for pricing (includes offset)
        uint256 virtualToken;       // tokens remaining in curve
        uint256 realUSDCCollected;  // actual USDC paid in (net of fees) toward graduation
        uint256 goblinScore;        // 0..100; oracle-set
        Label label;
        bool graduated;
        bool auctionTriggered;
        uint256 createdAt;
        uint256 flagCount;
        uint256 lifetimeVolumeUSDC; // for analytics / KING table
    }

    // ----------------------------------------------------------------
    // Storage
    // ----------------------------------------------------------------
    IERC20Min public immutable usdc;
    GoblinBadge public immutable badge;
    GoblinAccess public immutable access;
    GoblinTokenFactory public factory;
    IPvPRot public pvp; // optional PvP rot oracle; address(0) until set

    address public oracle; // legacy single-oracle pointer (kept for backwards-compat reads)
    mapping(address => bool) public isOracle; // M-1: multi-oracle set
    mapping(uint256 => uint256) public lastScoreUpdate; // M-1: per-token cooldown
    mapping(address => uint256) public pendingWithdrawals; // H-1: pull-pattern credits
    address public ancientAddress; // honorary single-seat ANCIENT rank
    uint256 public firstTradeBlock; // gates setAncient
    uint256 public accumulatedFees; // owner-withdrawable USDC fees
    uint256 public totalReserves;   // sum of all per-token realUSDCCollected
    uint256 public totalPendingWithdrawals; // sum of all pendingWithdrawals credits

    uint256 public nextTokenId = 1;
    mapping(uint256 => TokenState) public tokens;

    // Per-user, per-token state used for rugsSurvived detection
    mapping(uint256 => mapping(address => uint256)) public boughtAmount;

    // Flag uniqueness
    mapping(uint256 => mapping(address => bool)) public hasFlagged;

    // Top-10 by lifetime USDC volume (the KING table)
    address[TOP10_SIZE] public top10;
    mapping(address => uint256) public lifetimeUSDCVolume;

    // ----------------------------------------------------------------
    // Events
    // ----------------------------------------------------------------
    event TokenLaunched(uint256 indexed tokenId, address indexed token, address indexed creator, string name, string symbol, string metadataURI, uint256 launchedAt);
    event TokenPurchased(uint256 indexed tokenId, address indexed buyer, uint256 usdcIn, uint256 tokensOut, uint256 fee, uint256 virtualUSDCAfter, uint256 virtualTokenAfter, uint256 realUSDCCollectedAfter);
    event TokenSold(uint256 indexed tokenId, address indexed seller, uint256 tokensIn, uint256 usdcOut, uint256 fee, uint256 virtualUSDCAfter, uint256 virtualTokenAfter, uint256 realUSDCCollectedAfter);
    event GraduationFeeTaken(uint256 indexed tokenId, uint256 fee);
    event CreatorFeeAccrued(uint256 indexed tokenId, address indexed creator, uint256 amount);
    event GoblinScoreSet(uint256 indexed tokenId, uint256 score, Label label);
    event GraduationTriggered(uint256 indexed tokenId, uint256 realUSDC);
    event RescoringTriggered(uint256 indexed tokenId, uint256 flagCount);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event TokenFlagged(uint256 indexed tokenId, address indexed flagger, uint256 count);
    event FactorySet(address indexed factory);
    event OracleSet(address indexed oracle);
    event AncientSet(address indexed ancient);
    event AuctionReleased(uint256 indexed tokenId, address indexed relayer, uint256 amount);
    event OracleAdded(address indexed oracle);
    event OracleRemoved(address indexed oracle);
    event WithdrawalCredited(address indexed account, uint256 amount);
    event WithdrawalClaimed(address indexed account, uint256 amount);
    event PvPSet(address indexed pvp);
    event RotApplied(address indexed wallet, uint256 epoch, uint256 rotBps);

    // ----------------------------------------------------------------
    // Errors
    // ----------------------------------------------------------------
    error TokenNotFound();
    error TokenAlreadyGraduated();
    error TokenNotGraduated();
    error InsufficientPayment();
    error SlippageExceeded();
    error ZeroAmount();
    error BelowMinPurchase();
    error NotOracle();
    error AuctionAlreadyTriggered();
    error InvalidTokenParams();
    error TransferFailed();
    error NotEnoughRank();
    error AlreadyFlagged();
    error AlreadyHasBadge();
    error FactoryAlreadySet();
    error AncientAlreadySet();
    error NoTradesYet();
    error InvalidScore();
    error ReleaseAmountExceedsReserve();
    error ScoreCooldownActive();
    error NothingToClaim();
    error PvPAlreadySet();

    // ----------------------------------------------------------------
    // Constructor
    // ----------------------------------------------------------------
    constructor(address _usdc, address _badge, address _access, address initialOwner)
        Ownable(initialOwner)
    {
        // Wire collaborators once. The factory is set later (chicken/egg with curve address).
        if (_usdc == address(0) || _badge == address(0) || _access == address(0)) revert InvalidTokenParams();
        usdc = IERC20Min(_usdc);
        badge = GoblinBadge(_badge);
        access = GoblinAccess(_access);
        oracle = initialOwner; // bootstrap oracle to owner; rotated via setOracle
        isOracle[initialOwner] = true;
        emit OracleAdded(initialOwner);
    }

    // ----------------------------------------------------------------
    // Admin
    // ----------------------------------------------------------------
    /// @notice One-shot PvP wiring. After this is set, rank-progression counters and
    /// lifetime volume credit are scaled by the wallet's surviving rot multiplier for
    /// the current epoch. Trading economics (USDC, tokens, fees) are NEVER scaled —
    /// only the reputation-side accumulators.
    function setPvP(address _pvp) external onlyOwner {
        if (address(pvp) != address(0)) revert PvPAlreadySet();
        if (_pvp == address(0)) revert InvalidTokenParams();
        pvp = IPvPRot(_pvp);
        emit PvPSet(_pvp);
    }

    function setFactory(address _factory) external onlyOwner {
        // One-time wire so an attacker can't swap factories and inject malicious token code.
        if (address(factory) != address(0)) revert FactoryAlreadySet();
        if (_factory == address(0)) revert InvalidTokenParams();
        factory = GoblinTokenFactory(_factory);
        emit FactorySet(_factory);
    }

    /// @notice M-1: replace the entire oracle set with a single new oracle.
    /// Backwards-compatible with the previous single-oracle deploy flow.
    function setOracle(address _oracle) external onlyOwner {
        if (_oracle == address(0)) revert InvalidTokenParams();
        // Clear the previous primary oracle from the set if it was registered.
        if (oracle != address(0) && isOracle[oracle]) {
            isOracle[oracle] = false;
            emit OracleRemoved(oracle);
        }
        oracle = _oracle;
        if (!isOracle[_oracle]) {
            isOracle[_oracle] = true;
            emit OracleAdded(_oracle);
        }
        emit OracleSet(_oracle);
    }

    function addOracle(address _oracle) external onlyOwner {
        if (_oracle == address(0)) revert InvalidTokenParams();
        if (!isOracle[_oracle]) {
            isOracle[_oracle] = true;
            emit OracleAdded(_oracle);
        }
    }

    function removeOracle(address _oracle) external onlyOwner {
        if (isOracle[_oracle]) {
            isOracle[_oracle] = false;
            emit OracleRemoved(_oracle);
        }
    }

    function setAncient(address _ancient) external onlyOwner {
        // The ANCIENT rank is mythic — settable exactly once, and only after the protocol
        // has seen real activity. Prevents pre-bootstrapping a friend before launch.
        if (ancientAddress != address(0)) revert AncientAlreadySet();
        if (firstTradeBlock == 0) revert NoTradesYet();
        if (_ancient == address(0)) revert InvalidTokenParams();
        ancientAddress = _ancient;
        // Ensure they have a badge then stamp ANCIENT directly.
        if (!badge.hasBadge(_ancient)) badge.mint(_ancient);
        badge.rankUp(_ancient, GoblinBadge.Rank.ANCIENT);
        emit AncientSet(_ancient);
    }

    function withdrawFees(address to) external onlyOwner {
        // Owner sweep of protocol fees. Realised separately from `realUSDCCollected`
        // so fees never inflate graduation progress.
        if (to == address(0)) revert InvalidTokenParams();
        uint256 amt = accumulatedFees;
        accumulatedFees = 0;
        if (!usdc.transfer(to, amt)) revert TransferFailed();
        emit FeesWithdrawn(to, amt);
    }

    function releaseAuctionFunds(uint256 tokenId, address relayer, uint256 amount) external onlyOwner {
        // Post-graduation, owner releases the locked real USDC to a relayer that seeds
        // the external AMM. Single-shot per token to prevent double-release.
        TokenState storage t = tokens[tokenId];
        if (t.token == address(0)) revert TokenNotFound();
        if (!t.graduated) revert TokenNotGraduated();
        if (t.auctionTriggered) revert AuctionAlreadyTriggered();
        if (amount > t.realUSDCCollected) revert ReleaseAmountExceedsReserve();
        t.auctionTriggered = true;
        t.realUSDCCollected -= amount;
        totalReserves -= amount;
        // H-1: credit relayer instead of pushing USDC. If the relayer becomes blocklisted
        // or otherwise non-transferable, the protocol is not bricked — credit remains
        // claimable, and the relayer address must remain transfer-capable for it to be
        // withdrawn. Other tokens/auctions are unaffected by a single bad relayer.
        pendingWithdrawals[relayer] += amount;
        totalPendingWithdrawals += amount;
        emit WithdrawalCredited(relayer, amount);
        emit AuctionReleased(tokenId, relayer, amount);
    }

    /// @notice H-1 pull-pattern: any account with a positive pending balance withdraws
    /// their own credit. Reverts only on a USDC transfer failure (e.g. blocklist on
    /// msg.sender); the credit remains intact so a non-blocklisted controller can
    /// re-attempt by moving the credit off-chain isn't possible — the credit is bound
    /// to msg.sender. Document: the relayer wallet must never be blocklisted.
    function claim() external nonReentrant {
        uint256 amt = pendingWithdrawals[msg.sender];
        if (amt == 0) revert NothingToClaim();
        // Effects-before-interactions: zero out, then transfer. If the transfer reverts
        // (blocklisted recipient), the entire tx reverts and storage rolls back, so the
        // credit remains intact and a non-blocklisted controller can retry.
        pendingWithdrawals[msg.sender] = 0;
        totalPendingWithdrawals -= amt;
        if (!usdc.transfer(msg.sender, amt)) revert TransferFailed();
        emit WithdrawalClaimed(msg.sender, amt);
    }

    // ----------------------------------------------------------------
    // Launch
    // ----------------------------------------------------------------
    function launch(
        string memory name,
        string memory symbol,
        string memory metadataURI,
        uint256 initialBuyUSDC,
        uint256 minTokensOut
    ) external nonReentrant returns (uint256 tokenId, address tokenAddr) {
        if (address(factory) == address(0)) revert InvalidTokenParams();
        if (bytes(name).length == 0 || bytes(symbol).length == 0) revert InvalidTokenParams();

        // Deploy token via factory. Factory mints entire INITIAL_SUPPLY to this curve.
        tokenAddr = factory.deploy(name, symbol, INITIAL_SUPPLY, msg.sender);

        tokenId = nextTokenId++;
        TokenState storage t = tokens[tokenId];
        t.token = tokenAddr;
        t.creator = msg.sender;
        t.metadataURI = metadataURI;
        // Virtual reserves start with the offset so price discovery begins above zero
        // and early buyers can't get tokens for dust.
        t.virtualUSDC = VIRTUAL_USDC_OFFSET;
        t.virtualToken = INITIAL_SUPPLY;
        t.label = Label.NEUTRAL;
        t.createdAt = block.timestamp;

        // Ensure creator has a badge so reputation accrues from their own launch onward.
        if (!badge.hasBadge(msg.sender)) badge.mint(msg.sender);

        emit TokenLaunched(tokenId, tokenAddr, msg.sender, name, symbol, metadataURI, block.timestamp);

        // Optional creator first-buy in same tx — gives creators skin in the game.
        if (initialBuyUSDC > 0) {
            _buy(tokenId, msg.sender, initialBuyUSDC, minTokensOut);
        }
    }

    // ----------------------------------------------------------------
    // Buy / Sell
    // ----------------------------------------------------------------
    function buy(uint256 tokenId, uint256 usdcIn, uint256 minTokensOut)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        // Public entrypoint; the heavy lifting lives in _buy so launch() can reuse it.
        return _buy(tokenId, msg.sender, usdcIn, minTokensOut);
    }

    function _buy(uint256 tokenId, address buyer, uint256 usdcIn, uint256 minTokensOut)
        internal
        returns (uint256 tokensOut)
    {
        TokenState storage t = tokens[tokenId];
        if (t.token == address(0)) revert TokenNotFound();
        if (t.graduated) revert TokenAlreadyGraduated();
        if (usdcIn == 0) revert ZeroAmount();

        // Fee is read from access layer so it scales with the caller's rank in real time.
        uint256 feeBps = access.getFeeBps(buyer);
        uint256 fee = (usdcIn * feeBps) / BPS_DENOM;
        uint256 usdcAfterFee = usdcIn - fee;

        // H-2: clamp the buy so realUSDCCollected lands exactly on GRADUATION_THRESHOLD.
        // Beyond-threshold USDC isn't pulled at all — the buyer pays only for what fits.
        if (t.realUSDCCollected + usdcAfterFee > GRADUATION_THRESHOLD) {
            uint256 slack = GRADUATION_THRESHOLD - t.realUSDCCollected;
            // Solve usdcIn from usdcAfterFee == slack given feeBps.
            // usdcIn * (BPS_DENOM - feeBps) / BPS_DENOM == slack
            uint256 cappedUsdcIn = (slack * BPS_DENOM) / (BPS_DENOM - feeBps);
            // Ceil-correct so usdcAfterFee >= slack; then trim to exact.
            uint256 cappedFee = (cappedUsdcIn * feeBps) / BPS_DENOM;
            uint256 cappedAfterFee = cappedUsdcIn - cappedFee;
            // If integer division left us a hair short, bump up by 1 wei of USDC.
            while (cappedAfterFee < slack) {
                cappedUsdcIn += 1;
                cappedFee = (cappedUsdcIn * feeBps) / BPS_DENOM;
                cappedAfterFee = cappedUsdcIn - cappedFee;
            }
            // And trim back so cappedAfterFee == slack exactly (fee absorbs the diff).
            if (cappedAfterFee > slack) {
                cappedFee += (cappedAfterFee - slack);
                cappedAfterFee = slack;
            }
            usdcIn = cappedUsdcIn;
            fee = cappedFee;
            usdcAfterFee = cappedAfterFee;
        }

        // x*y=k constant product priced in 6-dec USDC vs 18-dec token. The k invariant
        // is preserved because we only update reserves by exactly the swap amounts.
        tokensOut = _getTokensOut(t.virtualUSDC, t.virtualToken, usdcAfterFee);
        if (tokensOut == 0) revert BelowMinPurchase();
        if (tokensOut < minTokensOut) revert SlippageExceeded();
        if (tokensOut > t.virtualToken) revert BelowMinPurchase();

        // Pull USDC. Fee accrues to protocol bucket separately so it never counts
        // toward graduation — keeps the threshold honest.
        if (!usdc.transferFrom(buyer, address(this), usdcIn)) revert TransferFailed();
        // Split fee: 20% to creator (pull-pattern), 80% to protocol bucket.
        uint256 creatorCut = (fee * CREATOR_FEE_SHARE_BPS) / BPS_DENOM;
        uint256 protocolFee = fee - creatorCut;
        accumulatedFees += protocolFee;
        if (creatorCut > 0) {
            pendingWithdrawals[t.creator] += creatorCut;
            totalPendingWithdrawals += creatorCut;
            emit CreatorFeeAccrued(tokenId, t.creator, creatorCut);
            emit WithdrawalCredited(t.creator, creatorCut);
        }

        // Update reserves and shipping inventory.
        t.virtualUSDC += usdcAfterFee;
        t.virtualToken -= tokensOut;
        t.realUSDCCollected += usdcAfterFee;
        totalReserves += usdcAfterFee;
        t.lifetimeVolumeUSDC += usdcAfterFee;

        // Mint badge on first trade for the buyer so reputation tracking starts immediately.
        if (!badge.hasBadge(buyer)) badge.mint(buyer);
        _maybeBump(buyer, 0); // tradeCount, scaled by PvP rot
        boughtAmount[tokenId][buyer] += tokensOut;

        // Ship tokens out from curve inventory to the buyer.
        if (!GoblinToken(t.token).transfer(buyer, tokensOut)) revert TransferFailed();

        // First-trade gate for setAncient bootstrap; record once.
        if (firstTradeBlock == 0) firstTradeBlock = block.number;

        // Graduation check — strictly >= so 69000.0 exactly trips it.
        if (!t.graduated && t.realUSDCCollected >= GRADUATION_THRESHOLD) {
            t.graduated = true;
            // Take 2% graduation fee: move from per-token reserve to protocol bucket.
            uint256 graduationFee = (t.realUSDCCollected * GRADUATION_FEE_BPS) / BPS_DENOM;
            t.realUSDCCollected -= graduationFee;
            totalReserves -= graduationFee;
            accumulatedFees += graduationFee;
            emit GraduationFeeTaken(tokenId, graduationFee);
            _maybeBump(buyer, 1); // graduationsWitnessed, scaled
            emit GraduationTriggered(tokenId, t.realUSDCCollected);
        }

        emit TokenPurchased(tokenId, buyer, usdcIn, tokensOut, fee, t.virtualUSDC, t.virtualToken, t.realUSDCCollected);

        // Update KING table and rank ladder for the buyer.
        // lifetime volume credit is scaled by PvP rot — trading economics above are NOT.
        _bumpVolumeAndMaybePromote(buyer, _scaledVol(buyer, usdcAfterFee));
        _checkRankUp(buyer);
    }

    function sell(uint256 tokenId, uint256 tokensIn, uint256 minUSDCOut)
        external
        nonReentrant
        returns (uint256 usdcOut)
    {
        TokenState storage t = tokens[tokenId];
        if (t.token == address(0)) revert TokenNotFound();
        if (t.graduated) revert TokenAlreadyGraduated();
        if (tokensIn == 0) revert ZeroAmount();

        // Compute raw USDC out, then deduct rank-scaled fee from the proceeds.
        uint256 usdcGross = _getUSDCOut(t.virtualUSDC, t.virtualToken, tokensIn);
        if (usdcGross == 0) revert BelowMinPurchase();
        uint256 feeBps = access.getFeeBps(msg.sender);
        uint256 fee = (usdcGross * feeBps) / BPS_DENOM;
        usdcOut = usdcGross - fee;
        if (usdcOut < minUSDCOut) revert SlippageExceeded();
        if (usdcGross > t.realUSDCCollected) revert BelowMinPurchase();

        // Pull tokens from seller and update reserves.
        if (!GoblinToken(t.token).transferFrom(msg.sender, address(this), tokensIn)) revert TransferFailed();
        t.virtualUSDC -= usdcGross;
        t.virtualToken += tokensIn;
        t.realUSDCCollected -= usdcGross;
        totalReserves -= usdcGross;
        t.lifetimeVolumeUSDC += usdcGross;
        // Split fee: 20% to creator, 80% to protocol.
        uint256 creatorCutS = (fee * CREATOR_FEE_SHARE_BPS) / BPS_DENOM;
        uint256 protocolFeeS = fee - creatorCutS;
        accumulatedFees += protocolFeeS;
        if (creatorCutS > 0) {
            pendingWithdrawals[t.creator] += creatorCutS;
            totalPendingWithdrawals += creatorCutS;
            emit CreatorFeeAccrued(tokenId, t.creator, creatorCutS);
            emit WithdrawalCredited(t.creator, creatorCutS);
        }

        // Mint badge on first trade for the seller too.
        if (!badge.hasBadge(msg.sender)) badge.mint(msg.sender);
        _maybeBump(msg.sender, 0); // tradeCount, scaled

        // Rugs-survived heuristic: if the token is currently labelled CURSED and the
        // seller previously bought a position here, count this exit as a rug survived.
        if (t.label == Label.CURSED && boughtAmount[tokenId][msg.sender] > 0) {
            _maybeBump(msg.sender, 2); // rugsSurvived, scaled
            // Clear so a single position only counts once per cursed label cycle.
            boughtAmount[tokenId][msg.sender] = 0;
        }

        if (!usdc.transfer(msg.sender, usdcOut)) revert TransferFailed();

        if (firstTradeBlock == 0) firstTradeBlock = block.number;

        emit TokenSold(tokenId, msg.sender, tokensIn, usdcOut, fee, t.virtualUSDC, t.virtualToken, t.realUSDCCollected);

        _bumpVolumeAndMaybePromote(msg.sender, _scaledVol(msg.sender, usdcGross));
        _checkRankUp(msg.sender);
    }

    // ----------------------------------------------------------------
    // Oracle / flags
    // ----------------------------------------------------------------
    function setGoblinScore(uint256 tokenId, uint256 score) external {
        // M-1: any registered oracle may score; cooldown prevents rapid flip-flopping.
        if (!isOracle[msg.sender]) revert NotOracle();
        if (score > 100) revert InvalidScore();
        TokenState storage t = tokens[tokenId];
        if (t.token == address(0)) revert TokenNotFound();
        uint256 last = lastScoreUpdate[tokenId];
        if (last != 0 && block.timestamp < last + SCORE_COOLDOWN) revert ScoreCooldownActive();
        lastScoreUpdate[tokenId] = block.timestamp;
        t.goblinScore = score;
        // Label thresholds: <40 CURSED, 40-69 NEUTRAL, >=70 BLESSED.
        if (score < 40) t.label = Label.CURSED;
        else if (score < 70) t.label = Label.NEUTRAL;
        else t.label = Label.BLESSED;
        emit GoblinScoreSet(tokenId, score, t.label);
    }

    function flagForRescore(uint256 tokenId) external {
        // Veteran-gated to keep the signal high. Each address counts at most once per token.
        if (!access.canFlagToken(msg.sender)) revert NotEnoughRank();
        TokenState storage t = tokens[tokenId];
        if (t.token == address(0)) revert TokenNotFound();
        if (hasFlagged[tokenId][msg.sender]) revert AlreadyFlagged();
        hasFlagged[tokenId][msg.sender] = true;
        t.flagCount += 1;
        emit TokenFlagged(tokenId, msg.sender, t.flagCount);
        if (t.flagCount >= access.getFlagThreshold()) {
            emit RescoringTriggered(tokenId, t.flagCount);
        }
    }

    // ----------------------------------------------------------------
    // Views / quotes
    // ----------------------------------------------------------------
    function graduationProgress(uint256 tokenId) external view returns (uint256) {
        // Returned in basis points (0..10000) so frontends can render a percentage cheaply.
        TokenState storage t = tokens[tokenId];
        if (t.token == address(0)) revert TokenNotFound();
        uint256 p = (t.realUSDCCollected * BPS_DENOM) / GRADUATION_THRESHOLD;
        return p > BPS_DENOM ? BPS_DENOM : p;
    }

    function quoteBuy(uint256 tokenId, uint256 usdcIn, address buyer)
        external
        view
        returns (uint256 tokensOut, uint256 fee)
    {
        // Pure math mirror of _buy; intended for UI estimates and tests.
        TokenState storage t = tokens[tokenId];
        if (t.token == address(0)) revert TokenNotFound();
        uint256 feeBps = access.getFeeBps(buyer);
        fee = (usdcIn * feeBps) / BPS_DENOM;
        tokensOut = _getTokensOut(t.virtualUSDC, t.virtualToken, usdcIn - fee);
    }

    function quoteSell(uint256 tokenId, uint256 tokensIn, address seller)
        external
        view
        returns (uint256 usdcOut, uint256 fee)
    {
        TokenState storage t = tokens[tokenId];
        if (t.token == address(0)) revert TokenNotFound();
        uint256 gross = _getUSDCOut(t.virtualUSDC, t.virtualToken, tokensIn);
        uint256 feeBps = access.getFeeBps(seller);
        fee = (gross * feeBps) / BPS_DENOM;
        usdcOut = gross - fee;
    }

    function currentPrice(uint256 tokenId) external view returns (uint256) {
        // Price = virtualUSDC / virtualToken scaled by 1e18 so it fits cleanly in a uint.
        // Note: USDC is 6-dec, token is 18-dec, so the raw ratio is tiny; the 1e18 scale
        // makes the number readable. Frontends should treat this as a relative price.
        TokenState storage t = tokens[tokenId];
        if (t.token == address(0)) revert TokenNotFound();
        return (t.virtualUSDC * 1e18) / t.virtualToken;
    }

    function getTopKings() external view returns (address[TOP10_SIZE] memory) {
        return top10;
    }

    /// @notice True if the contract's USDC balance covers all per-token reserves plus
    /// outstanding protocol fees. Exposed as a view so off-chain monitoring and tests
    /// can assert solvency without paying gas on every interaction.
    function solvencyInvariant() external view returns (bool) {
        return usdc.balanceOf(address(this)) >= totalReserves + accumulatedFees + totalPendingWithdrawals;
    }

    // ----------------------------------------------------------------
    // Internal math
    // ----------------------------------------------------------------
    function _getTokensOut(uint256 vUSDC, uint256 vToken, uint256 usdcIn)
        internal
        pure
        returns (uint256)
    {
        // Constant product: (vUSDC + dx)(vToken - dy) = vUSDC * vToken
        // => dy = vToken * dx / (vUSDC + dx)
        if (usdcIn == 0) return 0;
        return (vToken * usdcIn) / (vUSDC + usdcIn);
    }

    function _getUSDCOut(uint256 vUSDC, uint256 vToken, uint256 tokensIn)
        internal
        pure
        returns (uint256)
    {
        // dx = vUSDC * dy / (vToken + dy)
        if (tokensIn == 0) return 0;
        return (vUSDC * tokensIn) / (vToken + tokensIn);
    }

    // ----------------------------------------------------------------
    // PvP rot helpers
    // ----------------------------------------------------------------

    /// @notice Read the wallet's surviving progression fraction in bps from PvP.
    /// Returns BPS_DENOM (10000 = unaffected) when PvP isn't wired or query fails.
    function _rotMultBps(address wallet) internal view returns (uint256) {
        if (address(pvp) == address(0)) return BPS_DENOM;
        try pvp.getRotMultiplierBps(wallet) returns (uint256 m) {
            return m > BPS_DENOM ? BPS_DENOM : m;
        } catch {
            return BPS_DENOM;
        }
    }

    /// @notice Bump a count-based stat probabilistically: a fully-rotted wallet has 0
    /// chance of the bump landing; a fully-clean wallet always bumps. The pseudo-random
    /// draw uses block-bound entropy plus the wallet — cheap on-chain manipulability is
    /// acceptable because rot is reversible next epoch and the worst case is one missed
    /// or one extra count toward the rank threshold.
    function _maybeBump(address wallet, uint8 kind) internal {
        uint256 mult = _rotMultBps(wallet);
        if (mult >= BPS_DENOM) {
            _doCountBump(wallet, kind);
            return;
        }
        if (mult == 0) {
            emit RotApplied(wallet, block.timestamp / 3600, BPS_DENOM);
            return;
        }
        uint256 rng = uint256(keccak256(abi.encode(
            blockhash(block.number - 1),
            block.timestamp,
            wallet,
            kind,
            badge.tradeCount(wallet)
        ))) % BPS_DENOM;
        if (rng < mult) {
            _doCountBump(wallet, kind);
        } else {
            emit RotApplied(wallet, block.timestamp / 3600, BPS_DENOM - mult);
        }
    }

    function _doCountBump(address wallet, uint8 kind) internal {
        if (kind == 0) badge.bumpTradeCount(wallet);
        else if (kind == 1) badge.bumpGraduationsWitnessed(wallet);
        else if (kind == 2) badge.bumpRugsSurvived(wallet);
    }

    function _scaledVol(address wallet, uint256 vol) internal view returns (uint256) {
        uint256 mult = _rotMultBps(wallet);
        if (mult >= BPS_DENOM) return vol;
        return (vol * mult) / BPS_DENOM;
    }

    // ----------------------------------------------------------------
    // Rank ladder
    // ----------------------------------------------------------------
    function _checkRankUp(address wallet) internal {
        // Reads the freshly-bumped stats from the badge contract and applies the next
        // valid promotion, if any. Idempotent on the badge side so re-entry is fine.
        GoblinBadge.Rank current = badge.getRank(wallet);
        if (current == GoblinBadge.Rank.ANCIENT) return;

        uint256 trades = badge.tradeCount(wallet);
        uint256 grads = badge.graduationsWitnessed(wallet);
        uint256 rugs = badge.rugsSurvived(wallet);
        uint256 vol = lifetimeUSDCVolume[wallet];

        // H-6: require USDC-volume floors alongside count-based criteria so wash-trading
        // tiny amounts cannot promote a wallet through the rank ladder.
        if (current == GoblinBadge.Rank.CAVE && trades >= 5 && vol >= TRENCH_VOLUME_FLOOR) {
            badge.rankUp(wallet, GoblinBadge.Rank.TRENCH);
            current = GoblinBadge.Rank.TRENCH;
        }
        if (current == GoblinBadge.Rank.TRENCH && rugs >= 1 && vol >= CURSED_HUNTER_VOLUME_FLOOR) {
            badge.rankUp(wallet, GoblinBadge.Rank.CURSED_HUNTER);
            current = GoblinBadge.Rank.CURSED_HUNTER;
        }
        if (current == GoblinBadge.Rank.CURSED_HUNTER && grads >= 3 && vol >= VETERAN_VOLUME_FLOOR) {
            badge.rankUp(wallet, GoblinBadge.Rank.VETERAN);
            current = GoblinBadge.Rank.VETERAN;
        }
        // KING promotion is handled in _bumpVolumeAndMaybePromote since it depends
        // on the top-10 table rather than per-wallet thresholds.
    }

    function _bumpVolumeAndMaybePromote(address wallet, uint256 vol) internal {
        // Maintain a sorted top-10 by lifetime USDC volume. Linear-scan is fine because
        // the table is bounded to 10 entries — cheaper than a heap on-chain.
        lifetimeUSDCVolume[wallet] += vol;

        // H-5: the KING table is "top 10 VETERAN+ by volume" — a low-rank wallet with
        // huge volume is not considered for top10 (and so cannot be promoted to KING).
        bool eligible = badge.hasBadge(wallet) &&
            uint8(badge.getRank(wallet)) >= uint8(GoblinBadge.Rank.VETERAN);

        address[TOP10_SIZE] memory current = top10;

        // Already in the table? Re-sort in place.
        int256 existingIdx = -1;
        for (uint256 i = 0; i < TOP10_SIZE; i++) {
            if (current[i] == wallet) { existingIdx = int256(i); break; }
        }

        if (!eligible && existingIdx < 0) {
            // Skip insertion; volume already bumped for analytics. Done.
            return;
        }

        if (existingIdx >= 0) {
            // Bubble up.
            for (uint256 i = uint256(existingIdx); i > 0; i--) {
                if (lifetimeUSDCVolume[current[i - 1]] < lifetimeUSDCVolume[current[i]]) {
                    (current[i - 1], current[i]) = (current[i], current[i - 1]);
                } else break;
            }
        } else {
            // Try to insert at the lowest position whose holder we beat.
            uint256 lowestIdx = TOP10_SIZE; // sentinel
            for (uint256 i = 0; i < TOP10_SIZE; i++) {
                if (current[i] == address(0) ||
                    lifetimeUSDCVolume[current[i]] < lifetimeUSDCVolume[wallet]) {
                    lowestIdx = i;
                    break;
                }
            }
            if (lowestIdx < TOP10_SIZE) {
                // Push displaced wallet out the bottom.
                address displaced = current[TOP10_SIZE - 1];
                for (uint256 j = TOP10_SIZE - 1; j > lowestIdx; j--) {
                    current[j] = current[j - 1];
                }
                current[lowestIdx] = wallet;
                // Demote the displaced wallet if it was a KING.
                if (displaced != address(0) && badge.hasBadge(displaced)) {
                    if (badge.getRank(displaced) == GoblinBadge.Rank.KING) {
                        badge.demoteFromKing(displaced);
                    }
                }
            }
        }

        // Write back.
        for (uint256 i = 0; i < TOP10_SIZE; i++) {
            top10[i] = current[i];
        }

        // Promote to KING if eligible (must already be VETERAN and now in top10).
        if (badge.hasBadge(wallet)) {
            GoblinBadge.Rank r = badge.getRank(wallet);
            if (r == GoblinBadge.Rank.VETERAN) {
                for (uint256 i = 0; i < TOP10_SIZE; i++) {
                    if (top10[i] == wallet) {
                        badge.rankUp(wallet, GoblinBadge.Rank.KING);
                        break;
                    }
                }
            }
        }
    }
}
