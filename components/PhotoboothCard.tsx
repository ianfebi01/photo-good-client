'use client'
import Image from 'next/image'
import { useEffect, useRef } from 'react'
import { gsap } from 'gsap'

const photos = [
  {
    src     : 'https://images.unsplash.com/photo-1531746020798-e6953c6e8e04?w=600&q=80&fit=crop&crop=top',
    tagline : 'Snap it. Tag it.',
    hashtag : '#PhotoGood',
    desc    : 'Capture your best moments in every frame.',
  },
  {
    src     : 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=600&q=80&fit=crop&crop=top',
    tagline : 'Frame by frame.',
    hashtag : '#GoodShots',
    desc    : 'Every perspective deserves to be seen.',
  },
  {
    src     : 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=600&q=80&fit=crop&crop=top',
    tagline : 'Be the moment.',
    hashtag : '#LiveInFrame',
    desc    : 'Light, shadow, and a perfect instant.',
  },
  {
    src     : 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=600&q=80&fit=crop&crop=top',
    tagline : 'Tell your story.',
    hashtag : '#ClickGood',
    desc    : 'One click can change everything.',
  },
]

export default function PhotoboothCard() {
  const photoRefs     = useRef<( HTMLDivElement | null )[]>( [] )
  const captionTextRef = useRef<HTMLDivElement>( null )
  const taglineRef    = useRef<HTMLSpanElement>( null )
  const hashtagRef    = useRef<HTMLSpanElement>( null )
  const descRef       = useRef<HTMLParagraphElement>( null )
  const stack1Ref     = useRef<HTMLDivElement>( null )
  const stack2Ref     = useRef<HTMLDivElement>( null )
  const captionBoxRef = useRef<HTMLDivElement>( null )

  useEffect( () => {
    const ctx = gsap.context( () => {
      gsap.set( photoRefs.current.slice( 1 ), {
        autoAlpha : 0,
      } )

      gsap.set(
        [
          stack1Ref.current,
          stack2Ref.current,
          captionBoxRef.current,
        ],
        {
          y : 0,
        }
      )

      gsap.set( captionTextRef.current, {
        opacity : 1,
        y       : 0,
      } )

      const hold = 3.5
      const fadeDur = 0.8
      const textDur = 0.28
      const stackDur = 0.7

      const tl = gsap.timeline( {
        repeat : -1,
      } )

      photos.forEach( ( _, i ) => {
        const next = ( i + 1 ) % photos.length

        tl.to( {}, { duration : hold } )

        // Lift caption and reveal stack cards
        tl.to(
          stack2Ref.current,
          {
            y        : 10,
            duration : stackDur,
            ease     : 'power2.out',
          }
        )

        tl.to(
          stack1Ref.current,
          {
            y        : 16,
            duration : stackDur,
            ease     : 'power2.out',
          },
          '<+=0.1'
        )

        tl.to(
          captionBoxRef.current,
          {
            y        : -12,
            duration : stackDur,
            ease     : 'power2.out',
          },
          '<'
        )

        // Fade caption text out while caption lifts
        tl.to(
          captionTextRef.current,
          {
            opacity  : 0,
            y        : 8,
            duration : textDur,
            ease     : 'power2.in',
          },
          '<'
        )

        // Crossfade photos
        tl.to(
          photoRefs.current[i],
          {
            autoAlpha : 0,
            duration  : fadeDur,
            ease      : 'power2.inOut',
          },
          '<'
        )

        tl.to(
          photoRefs.current[next],
          {
            autoAlpha : 1,
            duration  : fadeDur,
            ease      : 'power2.inOut',
          },
          '<'
        )

        // Swap text while hidden
        tl.call( () => {
          if ( taglineRef.current )
            taglineRef.current.textContent = photos[next].tagline

          if ( hashtagRef.current )
            hashtagRef.current.textContent = photos[next].hashtag

          if ( descRef.current )
            descRef.current.textContent = photos[next].desc
        } )

        // Reposition above, then fade in — avoids fromTo immediateRender bug
        tl.set( captionTextRef.current, { y : -8 } )
        tl.to( captionTextRef.current, {
          opacity  : 1,
          y        : 0,
          duration : textDur,
          ease     : 'power2.out',
        } )

        // Hold new state briefly
        tl.to( {}, { duration : 0.7 } )

        // Return stack cards
        tl.to(
          [
            stack1Ref.current,
            stack2Ref.current,
            captionBoxRef.current,
          ],
          {
            y        : 0,
            duration : stackDur,
            ease     : 'power2.inOut',
          }
        )
      } )
    } )

    return () => ctx.revert()
  }, [] )

  return (
    <div className="relative w-full h-full min-h-64">
      {/* Photos */}
      {photos.map( ( photo, i ) => (
        <div
          key={i}
          ref={( el ) => {
            photoRefs.current[i] = el
          }}
          className="absolute inset-0"
          style={i !== 0 ? { opacity : 0, visibility : 'hidden' } : undefined}
        >
          <Image
            src={photo.src}
            alt={photo.hashtag}
            fill
            className="object-cover object-top"
            priority={i === 0}
          />
        </div>
      ) )}

      {/* Brand overlay */}
      <div className="absolute top-4 right-5 text-white text-sm font-semibold tracking-tight drop-shadow-md select-none z-10">
        photo good.<sup className="text-[10px]">™</sup>
      </div>

      {/* Caption stack area */}
      <div className="absolute bottom-0 left-0 right-0 z-10 px-3 pb-6">
        {/* Stacked bg rects — behind main caption, peek out on transition */}
        <div
          ref={stack1Ref}
          className="absolute inset-x-10 top-0 h-14 bg-secondary rounded-2xl"
        />
        <div
          ref={stack2Ref}
          className="absolute inset-x-6 top-0 h-14 bg-accent rounded-2xl"
        />

        {/* Main caption */}
        <div
          ref={captionBoxRef}
          className="relative bg-white/95 backdrop-blur-sm rounded-2xl px-4 py-3"
        >
          <div
            ref={captionTextRef}
            className="flex items-start justify-between gap-3"
          >
            <div className="flex flex-col leading-tight">
              <span
                ref={taglineRef}
                className="text-foreground font-bold text-base"
              >
                {photos[0].tagline}
              </span>

              <span
                ref={hashtagRef}
                className="text-accent font-bold text-base"
              >
                {photos[0].hashtag}
              </span>
            </div>

            <p
              ref={descRef}
              className="text-muted-foreground text-[11px] leading-snug text-right max-w-30 mt-0.5 font-poppins"
            >
              {photos[0].desc}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
