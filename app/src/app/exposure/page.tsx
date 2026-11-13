import { ExposureView } from '@/components/exposure/exposure-view';

export default async function ExposurePage({ searchParams }: { searchParams: Promise<{ quote?: string }> }) {
  const { quote } = await searchParams;
  return <ExposureView quoteId={quote ?? 'latest'} />;
}
