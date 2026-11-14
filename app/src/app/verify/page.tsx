import { VerifyView } from '@/components/verify/verify-view';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/verify?order=<id>` is where the QR code on an order confirmation points: it loads that order's receipt and checks it. */
export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ order?: string | string[] }> }) {
  const { order } = await searchParams;
  const id = typeof order === 'string' && UUID.test(order) ? order.toLowerCase() : undefined;
  return <VerifyView orderId={id} />;
}
