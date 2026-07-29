import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "AI Job Agent",
  description: "Automated AI-powered job application system",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const stripExtensionHydrationAttributes = `
(() => {
  const ATTRS = ["bis_skin_checked"];
  const strip = (root) => {
    for (const attr of ATTRS) {
      if (root?.removeAttribute) root.removeAttribute(attr);
    }
    root?.querySelectorAll?.(ATTRS.map((attr) => "[" + attr + "]").join(","))
      .forEach((node) => ATTRS.forEach((attr) => node.removeAttribute(attr)));
  };

  strip(document.documentElement);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes" && ATTRS.includes(mutation.attributeName)) {
        mutation.target.removeAttribute(mutation.attributeName);
      }
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) strip(node);
      });
    }
  });

  observer.observe(document.documentElement, {
    attributes: true,
    childList: true,
    subtree: true,
    attributeFilter: ATTRS,
  });

  window.addEventListener("load", () => observer.disconnect(), { once: true });
})();
`;

  return (
    // suppressHydrationWarning: browser extensions (e.g. Bitdefender adds
    // bis_register / __processed_* attributes to <body> before React hydrates),
    // which would otherwise trigger a harmless attribute-mismatch warning.
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className={inter.className} suppressHydrationWarning>
        <script
          dangerouslySetInnerHTML={{ __html: stripExtensionHydrationAttributes }}
        />
        {children}
      </body>
    </html>
  );
}
