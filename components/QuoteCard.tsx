'use client'
import { useEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { cn } from '@/lib/utils'

const quotes = [
  {
    text   : 'Photography is the art of frozen time — the ability to store emotion and feelings within a frame.',
    author : 'Meshack Otieno',
  },
  {
    text   : 'A photograph is a secret about a secret. The more it tells you, the less you know.',
    author : 'Diane Arbus',
  },
  {
    text   : 'In photography, the smallest thing can be a great subject. The little human detail can become a leitmotif.',
    author : 'Henri Cartier-Bresson',
  },
  {
    text   : 'Photography takes an instant out of time, altering life by holding it still.',
    author : 'Dorothea Lange',
  },
]

interface QuoteCardProps {
  className?: string
}

export default function QuoteCard( { className }: QuoteCardProps ) {
  const containerRef = useRef<HTMLDivElement>( null )
  const quoteRef = useRef<HTMLParagraphElement>( null )
  const authorRef = useRef<HTMLSpanElement>( null )
  const markRef = useRef<HTMLSpanElement>( null )
  const [index, setIndex] = useState( 0 )

  useEffect( () => {
    const ctx = gsap.context( () => {
      const tl = gsap.timeline( { repeat : -1, delay : 0.5 } )

      const hold = 4
      const animDur = 0.6

      quotes.forEach( ( _, i ) => {
        // Entrance
        tl.fromTo(
          [markRef.current, quoteRef.current, authorRef.current],
          { autoAlpha : 0, y : 24 },
          {
            autoAlpha : 1,
            y         : 0,
            duration  : animDur,
            stagger   : 0.1,
            ease      : 'power3.out',
            onStart   : () => setIndex( i ),
          },
        )

        // Hold
        tl.to( {}, { duration : hold } )

        // Exit
        tl.to(
          [authorRef.current, quoteRef.current, markRef.current],
          {
            autoAlpha : 0,
            y         : -20,
            duration  : animDur * 0.8,
            stagger   : 0.08,
            ease      : 'power3.in',
          },
        )
      } )
    } )

    return () => ctx.revert()
  }, [] )

  return (
    <div
      ref={containerRef}
      className={cn( 'flex flex-col justify-between h-full', className )}
    >
      <span
        ref={markRef}
        className="text-white/30 text-8xl font-serif leading-none select-none -mt-4"
        style={{ visibility : 'hidden' }}
      >
        &ldquo;
      </span>
      <p
        ref={quoteRef}
        className="text-white text-base font-medium leading-relaxed flex-1"
        style={{ visibility : 'hidden' }}
      >
        {quotes[index].text}
      </p>
      <span
        ref={authorRef}
        className="text-white/60 text-sm mt-4 block"
        style={{ visibility : 'hidden' }}
      >
        — {quotes[index].author}
      </span>
    </div>
  )
}
