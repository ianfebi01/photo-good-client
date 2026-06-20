import Link from 'next/dist/client/link'

const LogoLink = () => {
  return (
    <Link href="/"
      className="flex items-center gap-3"
    >
      <div
        className="group relative flex size-8 items-center justify-center cursor-pointer disabled:cursor-not-allowed select-none rounded-full focus:outline-none disabled:opacity-50"
        title="Snap"
      >
        <span className="absolute inset-0 rounded-full border-2 border-primary" />
        <span className="absolute inset-1 rounded-full bg-primary transition-transform duration-150 group-hover:scale-105 group-active:scale-90 group-disabled:scale-100"></span>
      </div>
      <span className="text-lg font-bold text-neutral-900 font-sans">
        photogood.
      </span>
    </Link>
  )
}

export default LogoLink
