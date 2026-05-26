import type { Metadata } from "next";
import "./globals.css";
import { AppHeader } from "@/components/AppHeader";

export const metadata: Metadata = {
  title: "SPM Dev Agent",
  description: "PECO Smart Pet Medical — AI開発エージェントシステム",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-slate-50">
        <AppHeader />
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
