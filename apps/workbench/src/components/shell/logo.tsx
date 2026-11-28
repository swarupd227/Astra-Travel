import clsx from 'clsx';

/**
 * The mark's gradient is plain CSS: an SVG gradient referenced by id disappears when the first copy
 * of the logo on the page is hidden (the desktop sidebar on a phone).
 */
export function Logo({
  tone = 'inverse',
  endorsement = false,
  wordmarkClassName,
}: {
  /** `inverse` for dark backgrounds, `default` for the page surface. */
  tone?: 'inverse' | 'default';
  endorsement?: boolean;
  wordmarkClassName?: string;
}) {
  const inverse = tone === 'inverse';
  return (
    <span className="inline-flex items-center gap-2.5">
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-[#8fb0ff] to-[#4fd1bd]"
      >
        <svg viewBox="0 0 32 32" className="size-8">
          <path
            d="M16 6.5 22.5 25h-3.3l-1.4-4.3h-5.6L10.8 25H7.5L14 6.5h2Zm-.9 5.1-2 6.3h4l-2-6.3Z"
            fill="#0c1a33"
          />
        </svg>
      </span>
      <span className={clsx('flex flex-col leading-tight', wordmarkClassName)}>
        <span
          className={clsx(
            'text-[15px] font-semibold tracking-tight',
            inverse ? 'text-white' : 'text-fg',
          )}
        >
          Astra{' '}
          <span className={clsx('font-normal', inverse ? 'text-[#c3cee2]' : 'text-muted')}>
            Travel
          </span>
        </span>
        {endorsement ? (
          <span className={clsx('text-[11px]', inverse ? 'text-[#c3cee2]' : 'text-muted')}>
            Assurant Travel
          </span>
        ) : null}
      </span>
    </span>
  );
}
