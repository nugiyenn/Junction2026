import type { Metadata } from "next";
import { Barlow_Condensed, Inter } from "next/font/google";
import { AppNav } from "@/components/app-nav";
import "./globals.css";

// Valio Aimo sets body text in Matter and headings in National (both licensed). Inter and Barlow Condensed
// are the free stand-ins; swap the two variables in globals.css if you hold the licences.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const barlow = Barlow_Condensed({
  variable: "--font-barlow",
  subsets: ["latin"],
  weight: ["600", "700", "800", "900"],
});

export const metadata: Metadata = {
  title: "Trusted Trade Gateway",
  description: "How a buyer's purchasing agent orders from Valio Aimo within its mandate",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${barlow.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <AppNav />
        <main className="min-w-0 flex-1">{children}</main>
      </body>
    </html>
  );
}
