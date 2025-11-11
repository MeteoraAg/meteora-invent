import { Html, Head, Main, NextScript } from 'next/document';
import Script from 'next/script';

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <Script src="https://terminal.jup.ag/main-v4.js" />
        <meta name="title" content="TrenchFun - Fair Launch Platform" />
        <meta name="description" content="Launch and trade Solana tokens with fair bonding curves. No presales, no team allocation." />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <body className="antialiased bg-black">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
