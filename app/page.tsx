import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import LogoCard from '@/components/LogoCard'
import PhotoStack from '@/components/PhotoStack'
import PalleteStack from '../components/PalleteStack'
import PhotoboothCard from '@/components/PhotoboothCard'
import QuoteCard from '@/components/QuoteCard'
import AppCard from '@/components/AppCard'
import Link from 'next/link'
import { FRAMES_QUERY_KEY } from '@/lib/photobooth/frames.query'
import { getFramesForSsr } from '@/lib/photobooth/frames.query.server'
import { FrameSyncTrigger } from '@/components/FrameSyncTrigger'

export default async function Home() {
  const queryClient = new QueryClient()
  await queryClient.prefetchQuery( {
    queryKey : [...FRAMES_QUERY_KEY, { page : 1, limit : 5 }],
    queryFn  : () => getFramesForSsr( { page : 1, limit : 5 } ),
  } )

  return (
    <HydrationBoundary state={dehydrate( queryClient )}>
      <FrameSyncTrigger />
      <main className="min-h-screen lg:min-h-[unset] lg:h-screen bg-white">
        <div className="container px-4 py-8 mx-auto lg:py-16 lg:h-full">
          <div
            className={cn(
              'grid gap-12 h-full',
              'grid-cols-1',
              'lg:grid-cols-12',
              'lg:auto-rows-fr',
            )}
          >
            {/* Top Left */}
            <PhotoStack className="max-lg:h-125 lg:col-span-4 lg:row-span-9" />

            {/* Hero */}
            <AppCard className="relative overflow-hidden bg-secondary p-8 max-lg:order-last lg:col-span-4 lg:row-span-5 text-secondary-foreground flex flex-col justify-between">
              {/* Ambient glow */}
              <div className="pointer-events-none absolute -top-16 -right-16 h-56 w-56 rounded-full bg-secondary-foreground/10 blur-3xl" />

              {/* Title */}
              <div className="relative z-10 flex flex-col gap-3">
                <h1 className="text-4xl font-bold leading-tight">
                  Let&apos;s Capture<br />Some Memories
                </h1>
                <p className="max-w-47.5 text-sm leading-relaxed text-secondary-foreground/60 font-poppins">
                  Your personal photo booth, wrapped in warm memories.
                </p>
              </div>

              {/* Starburst START button */}
              <div className="relative z-10 flex items-center justify-center">
                <Link
                  href="/booth"
                  className="group relative flex items-center"
                >
                  <div
                    className="group relative flex size-20 items-center justify-center cursor-pointer disabled:cursor-not-allowed select-none rounded-full focus:outline-none disabled:opacity-50"
                    title="Snap"
                  >
                    <span className="absolute inset-0 rounded-full border-3 border-primary" />
                    <span className="absolute inset-1.5 rounded-full bg-primary transition-transform duration-150 group-hover:scale-105 group-active:scale-90 group-disabled:scale-100"></span>
                  </div>
                  <span className="text-2xl font-bold text-neutral-700 font-sans ml-2">
                    Start!
                  </span>
                </Link>
              </div>
            </AppCard>

            {/* Right Portrait */}
            <AppCard className="max-lg:h-auto max-lg:aspect-square lg:col-span-4 lg:row-span-5 p-0! overflow-hidden">
              <PhotoboothCard />
            </AppCard>

            {/* Quote */}
            <AppCard className="text-white bg-chart-2 lg:col-span-3 lg:row-span-4 flex flex-col">
              <QuoteCard />
            </AppCard>

            {/* Logo */}
            <LogoCard className="lg:col-span-5 lg:row-span-2" />

            {/* Colors */}
            <PalleteStack className="max-lg:h-24 lg:col-span-5 lg:row-span-2" />
          </div>

        </div>
      </main>
    </HydrationBoundary>
  )
}
