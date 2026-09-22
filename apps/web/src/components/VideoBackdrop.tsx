import { useEffect, useRef } from "react";

interface VideoBackdropProps {
  className?: string;
}

export function VideoBackdrop({ className = "" }: VideoBackdropProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.playbackRate = 0.65;
    const playback = video.play();
    playback?.catch(() => undefined);
  }, []);

  return (
    <>
      <video
        ref={videoRef}
        aria-hidden="true"
        autoPlay
        className={`kazi-video-backdrop ${className}`.trim()}
        loop
        muted
        playsInline
        poster="/logo.png"
        preload="metadata"
      >
        <source src="/backgroundvideo.mp4" type="video/mp4" />
      </video>
      <div aria-hidden="true" className="kazi-video-scrim" />
      <div aria-hidden="true" className="kazi-video-gradient" />
    </>
  );
}
