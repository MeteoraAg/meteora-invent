import Explore from '@/components/Explore';
import Page from '@/components/ui/Page/Page';
import Head from 'next/head';

export default function Index() {
  return (
    <>
      <Head>
        <title>TrenchFun - Launch a Token for the Trenches</title>
        <meta
          name="description"
          content="Discover and launch tokens in the trenches. Fair bonding curves, no presales, no team allocation."
        />
      </Head>
      <Page>
        <Explore />
      </Page>
    </>
  );
}
