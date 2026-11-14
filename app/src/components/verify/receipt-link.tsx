import Link from 'next/link';

/** Downloads the signed receipt for an order, with a link to the page that checks it. */
export function ReceiptLink({ id }: { id: string }) {
  return (
    <p className="flex flex-wrap gap-x-3 text-[13px]">
      <a href={`/api/orders/${id}/receipt`} download={`receipt-${id.slice(0, 8)}.json`} className="underline">
        Receipt
      </a>
      <Link href="/verify" className="underline">
        Verify
      </Link>
    </p>
  );
}
