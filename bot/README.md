# goblinmode bot

X/Twitter automation. Listens to `TokenLaunched`, `GraduationTriggered`, `TokenFlagged`,
`RescoringTriggered` events on the GoblinCurve and posts threads.

TODO:
- index.js: ethers WebSocketProvider + curve event subscriptions
- compose tweet templates per event type
- rate-limit + dedupe
- optional Telegram + Discord webhook fan-out
