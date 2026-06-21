'use client'

import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

export interface ProvidersProps {
  children: React.ReactNode
}

export default function Providers( { children }: ProvidersProps ) {
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
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}
