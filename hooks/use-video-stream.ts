import { useState, useRef, useCallback } from 'react';

export function useVideoStream() {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isWebcamActive, setIsWebcamActive] = useState(false);
  const [isScreenShareActive, setIsScreenShareActive] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingPaused, setRecordingPaused] = useState(false);

  const startWebcam = useCallback(async (facing?: 'user' | 'environment') => {
    try {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
      const mode = facing || facingMode;
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: mode },
      });
      setStream(newStream);
      setIsWebcamActive(true);
      setIsScreenShareActive(false);
      setFacingMode(mode);
      if (videoRef.current) {
        videoRef.current.srcObject = newStream;
      }
    } catch (err) {
      console.error("Error accessing webcam", err);
    }
  }, [stream, facingMode]);

  const flipCamera = useCallback(() => {
    const next = facingMode === 'user' ? 'environment' : 'user';
    startWebcam(next);
  }, [facingMode, startWebcam]);

  const startScreenShare = useCallback(async () => {
    try {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
      const newStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
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
  }, [stream]);

  const stopStream = useCallback(() => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
    }
    setStream(null);
    setIsWebcamActive(false);
    setIsScreenShareActive(false);
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    setIsRecording(false);
    setRecordingPaused(false);
    recordedChunksRef.current = [];
  }, [stream]);

  const startRecording = useCallback(() => {
    if (!stream) return;
    recordedChunksRef.current = [];
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `recording-${Date.now()}.webm`;
      a.click();
    };
    recorder.start(100);
    mediaRecorderRef.current = recorder;
    setIsRecording(true);
    setRecordingPaused(false);
  }, [stream]);

  const togglePauseRecording = useCallback(() => {
    if (!mediaRecorderRef.current) return;
    if (mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.pause();
      setRecordingPaused(true);
    } else {
      mediaRecorderRef.current.resume();
      setRecordingPaused(false);
    }
  }, []);

  const takeSnapshot = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (facingMode === 'user') {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0);
    const link = document.createElement('a');
    link.download = `snapshot-${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }, [facingMode]);

  return {
    stream,
    videoRef,
    isWebcamActive,
    isScreenShareActive,
    facingMode,
    startWebcam,
    flipCamera,
    startScreenShare,
    stopStream,
    isRecording,
    recordingPaused,
    startRecording,
    togglePauseRecording,
    takeSnapshot,
  };
}
