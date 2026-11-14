import { cn } from 'cn';
import { buttonVariants } from '@/components/ui/button';

/**
 * Opens the order confirmation (a PDF, not an invoice) for an order in a new tab. `button` is the secondary outline
 * button for where an order has just been placed; `link` is the small text link for cards in a list.
 */
export function ConfirmationLink({ id, variant = 'button' }: { id: string; variant?: 'button' | 'link' }) {
  return (
    <a
      href={`/api/orders/${id}/confirmation`}
      target="_blank"
      rel="noopener"
      className={variant === 'button' ? cn(buttonVariants({ variant: 'outline', size: 'sm', className: 'w-fit' })) : 'text-[13px] underline'}
    >
      Order confirmation (PDF)
    </a>
  );
}
