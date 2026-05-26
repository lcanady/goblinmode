export default function Home() {
  return (
    <main style={{
      minHeight: "100vh",
      background: "#0a0a0a",
      color: "#7CFC00",
      fontFamily: "monospace",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: 32,
    }}>
      <h1 style={{ fontSize: 64, textShadow: "0 0 12px #7CFC00" }}>goblinmode.fun</h1>
      <p style={{ marginTop: 24, opacity: 0.8 }}>
        trustless memecoin launchpad on Monad
      </p>
      <p style={{ marginTop: 8, opacity: 0.5, fontSize: 12 }}>
        wire up wagmi + contract ABIs to enable launch / buy / sell flows.
      </p>
    </main>
  );
}
