import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import { AppNav } from "@/components/app-nav";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Trusted Trade Gateway",
  description: "How a buyer's purchasing agent orders from Valio Aimo within its mandate",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${spaceGrotesk.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col md:flex-row">
        <AppNav />
        <main className="min-w-0 flex-1">{children}</main>
      </body>
    </html>
  );
}
