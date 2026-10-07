import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DropSend",
  description:
    "Encrypted browser-to-browser file transfer. No accounts, no cloud storage.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
