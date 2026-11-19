import "./globals.css";

export const metadata = {
  title: "Building Energy Evidence Assistant",
  description: "Ask questions about ASHRAE building energy data. Answers cite traceable evidence, show uncertainty and ask for missing information.",
};

export const viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <a href="/" className="brand" aria-label="Building Energy Evidence Assistant — home">
            <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><rect x="3" y="9" width="6" height="14" rx="1.5" fill="var(--series-1)" /><rect x="10.5" y="4" width="6" height="19" rx="1.5" fill="var(--series-1)" opacity=".7" /><rect x="18" y="13" width="5" height="10" rx="1.5" fill="var(--series-2)" /></svg>
            <span>Building Energy Evidence Assistant</span>
          </a>
          <nav aria-label="Main">
            <a href="/">Assistant</a>
            <a href="/evaluation">Evaluation</a>
            <a href="/method">Method &amp; limits</a>
          </nav>
        </header>
        {children}
        <footer className="foot">
          Built on the ASHRAE Great Energy Predictor III dataset · Qwen3.5-2B (Apache-2.0) · figures from approved Python calculations · not a substitute for a qualified energy adviser.
        </footer>
      </body>
    </html>
  );
}
