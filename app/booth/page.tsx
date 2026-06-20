import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query'

import { BoothClient } from './BoothClient'
import { FRAMES_QUERY_KEY } from '@/lib/photobooth/frames.query'
import { getFramesForSsr } from '@/lib/photobooth/frames.query.server'

export default async function BoothPage() {
  const queryClient = new QueryClient()
  await queryClient.prefetchQuery( {
    queryKey : FRAMES_QUERY_KEY,
    queryFn  : () => getFramesForSsr( { page : 1, limit : 200 } ),
  } )

  return (
    <HydrationBoundary state={dehydrate( queryClient )}>
      <BoothClient />
    </HydrationBoundary>
  )
}
