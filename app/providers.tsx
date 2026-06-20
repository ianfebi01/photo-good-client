'use client'

import { useState } from 'react'
import { HydrationBoundary, QueryClient, QueryClientProvider, type DehydratedState } from '@tanstack/react-query'

export interface ProvidersProps {
  children: React.ReactNode
  dehydratedState?: DehydratedState | null
}

export default function Providers( { children, dehydratedState }: ProvidersProps ) {
  const [queryClient] = useState(
    () =>
      new QueryClient( {
        defaultOptions : {
          queries : {
            refetchOnWindowFocus : false,
            refetchOnMount       : false,
            retry                : false,
            staleTime            : 1000 * 60,
          },
        },
      } ),
  )

  return (
    <QueryClientProvider client={queryClient}>
      <HydrationBoundary state={dehydratedState}>{children}</HydrationBoundary>
    </QueryClientProvider>
  )
}
