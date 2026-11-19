export function Logo() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg aria-hidden viewBox="0 0 32 32" className="size-7">
        <defs>
          <linearGradient id="astra-mark" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#7aa0ff" />
            <stop offset="1" stopColor="#4fd1bd" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="8" fill="url(#astra-mark)" />
        <path
          d="M16 6.5 22.5 25h-3.3l-1.4-4.3h-5.6L10.8 25H7.5L14 6.5h2Zm-.9 5.1-2 6.3h4l-2-6.3Z"
          fill="#0c1a33"
        />
      </svg>
      <span className="text-[15px] font-semibold tracking-tight text-white">
        Astra <span className="font-normal text-[#c3cee2]">Travel</span>
      </span>
    </span>
  );
}
