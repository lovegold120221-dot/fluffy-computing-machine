import { useState, useEffect, useRef } from 'react';

export function useVideoStream() {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isWebcamActive, setIsWebcamActive] = useState(false);
  const [isScreenShareActive, setIsScreenShareActive] = useState(false);

  const startWebcam = async () => {
    try {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
      const newStream = await navigator.mediaDevices.getUserMedia({ video: true });
      setStream(newStream);
      setIsWebcamActive(true);
      setIsScreenShareActive(false);
      if (videoRef.current) {
        videoRef.current.srcObject = newStream;
      }
    } catch (err) {
      console.error("Error accessing webcam", err);
    }
  };

  const startScreenShare = async () => {
    try {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
      const newStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      
      // Listen for when user stops screen share via browser UI
      newStream.getVideoTracks()[0].addEventListener('ended', () => {
        stopStream();
      });

      setStream(newStream);
      setIsScreenShareActive(true);
      setIsWebcamActive(false);
      if (videoRef.current) {
        videoRef.current.srcObject = newStream;
      }
    } catch (err) {
      console.error("Error accessing screen share", err);
    }
  };

  const stopStream = () => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
    }
    setStream(null);
    setIsWebcamActive(false);
    setIsScreenShareActive(false);
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  return {
    stream,
    videoRef,
    isWebcamActive,
    isScreenShareActive,
    startWebcam,
    startScreenShare,
    stopStream
  };
}
