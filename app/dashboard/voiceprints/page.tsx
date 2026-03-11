'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getVoiceprintSpeakers,
  getVoiceprintClips,
  updateVoiceprintClipStatus,
  VoiceprintSpeaker,
  VoiceprintClip,
} from '@/lib/api';

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    candidate: 'bg-yellow-100 text-yellow-800',
    approved: 'bg-green-100 text-green-800',
    rejected: 'bg-red-100 text-red-800',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] || 'bg-gray-100 text-gray-800'}`}>
      {status}
    </span>
  );
}

function ClipCard({
  clip,
  index,
  onStatusChange,
  isPlaying,
  onPlay,
  onStop,
}: {
  clip: VoiceprintClip;
  index: number;
  onStatusChange: (clipId: string, status: 'approved' | 'rejected' | 'candidate') => void;
  isPlaying: boolean;
  onPlay: (clipId: string) => void;
  onStop: () => void;
}) {
  const rawScore = clip.similarity_score != null ? Number(clip.similarity_score) : null;
  const simScore = rawScore != null && !isNaN(rawScore) ? rawScore : null;
  const sourceLabel = clip.source_video ? `Video: ${clip.source_video}` : '';
  const timeLabel = clip.timestamp_s ? `@ ${clip.timestamp_s}s` : '';

  return (
    <div
      className={`border rounded-lg p-3 transition-all ${
        clip.status === 'approved'
          ? 'border-green-300 bg-green-50'
          : clip.status === 'rejected'
          ? 'border-red-200 bg-red-50 opacity-60'
          : 'border-gray-200 bg-white'
      } ${isPlaying ? 'ring-2 ring-blue-400' : ''}`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-mono font-bold text-gray-700">#{index + 1}</span>
          <StatusBadge status={clip.status} />
        </div>
        {simScore != null && (
          <span className={`text-xs font-mono ${simScore >= 0.9 ? 'text-green-600' : simScore >= 0.8 ? 'text-yellow-600' : 'text-red-600'}`}>
            sim: {simScore.toFixed(3)}
          </span>
        )}
      </div>

      {/* Audio player */}
      <div className="mb-2">
        {clip.audio_url ? (
          <button
            onClick={() => (isPlaying ? onStop() : onPlay(clip.clip_id))}
            className={`w-full py-2 px-3 rounded text-sm font-medium transition-colors ${
              isPlaying
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {isPlaying ? '⏹ Stop' : '▶ Play'}
          </button>
        ) : (
          <span className="text-xs text-red-500">No audio</span>
        )}
      </div>

      {/* Source info */}
      <div className="text-xs text-gray-400 mb-2 truncate" title={`${sourceLabel} ${timeLabel}`}>
        {sourceLabel} {timeLabel}
      </div>

      {/* Thumbs up / down */}
      <div className="flex gap-2">
        <button
          onClick={() => onStatusChange(clip.clip_id, clip.status === 'approved' ? 'candidate' : 'approved')}
          className={`flex-1 py-1.5 rounded text-lg transition-colors ${
            clip.status === 'approved'
              ? 'bg-green-500 text-white'
              : 'bg-gray-100 hover:bg-green-100 text-gray-500 hover:text-green-600'
          }`}
          title="Approve"
        >
          👍
        </button>
        <button
          onClick={() => onStatusChange(clip.clip_id, clip.status === 'rejected' ? 'candidate' : 'rejected')}
          className={`flex-1 py-1.5 rounded text-lg transition-colors ${
            clip.status === 'rejected'
              ? 'bg-red-500 text-white'
              : 'bg-gray-100 hover:bg-red-100 text-gray-500 hover:text-red-600'
          }`}
          title="Reject"
        >
          👎
        </button>
      </div>
    </div>
  );
}

export default function VoiceprintsPage() {
  const [speakers, setSpeakers] = useState<VoiceprintSpeaker[]>([]);
  const [selectedSpeaker, setSelectedSpeaker] = useState<string>('');
  const [clips, setClips] = useState<VoiceprintClip[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [playingClipId, setPlayingClipId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'candidate' | 'approved' | 'rejected'>('all');
  const [showNewSpeaker, setShowNewSpeaker] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Load speakers on mount
  useEffect(() => {
    loadSpeakers();
    return () => stopAudio();
  }, []);

  async function loadSpeakers() {
    try {
      const data = await getVoiceprintSpeakers();
      setSpeakers(data.speakers);
    } catch (err: any) {
      setError(err.message || 'Failed to load speakers');
    }
  }

  const loadClips = useCallback(async (speaker: string) => {
    setLoading(true);
    setError('');
    try {
      const data = await getVoiceprintClips(speaker);
      setClips(data.clips);
    } catch (err: any) {
      setError(err.message || 'Failed to load clips');
    } finally {
      setLoading(false);
    }
  }, []);

  function selectSpeaker(speaker: string) {
    setSelectedSpeaker(speaker);
    setFilter('all');
    setPlayingClipId(null);
    stopAudio();
    loadClips(speaker);
  }

  async function handleStatusChange(clipId: string, newStatus: 'approved' | 'rejected' | 'candidate') {
    try {
      await updateVoiceprintClipStatus(selectedSpeaker, clipId, newStatus);
      // Update local state
      setClips((prev) =>
        prev.map((c) => (c.clip_id === clipId ? { ...c, status: newStatus } : c))
      );
      // Update speaker counts
      loadSpeakers();
    } catch (err: any) {
      setError(err.message || 'Failed to update clip status');
    }
  }

  function stopAudio() {
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current.src = '';
    }
    setPlayingClipId(null);
  }

  function playClip(clipId: string) {
    const clip = clips.find((c) => c.clip_id === clipId);
    if (!clip?.audio_url) return;

    stopAudio();

    const audio = new Audio(clip.audio_url);
    audioRef.current = audio;
    setPlayingClipId(clipId);

    audio.onended = () => setPlayingClipId(null);
    audio.onerror = () => {
      setPlayingClipId(null);
      setError('Failed to play audio');
    };
    audio.play();
  }

  const approvedClips = clips.filter((c) => c.status === 'approved');
  const filteredClips = filter === 'all' ? clips : clips.filter((c) => c.status === filter);
  const approvedCount = approvedClips.length;
  const candidateCount = clips.filter((c) => c.status === 'candidate').length;

  return (
    <div className="space-y-4">
      {/* New Speaker Modal */}
      {showNewSpeaker && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowNewSpeaker(false)}>
          <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 mb-3">➕ Add a New Speaker</h3>
            <div className="space-y-3 text-sm text-gray-700">
              <p>
                Adding a new speaker requires extracting audio clips from YouTube interviews.
                The Copilot AI can do this automatically.
              </p>
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <p className="font-semibold text-blue-900 mb-1">Tell Copilot:</p>
                <p className="font-mono text-xs text-blue-800 bg-blue-100 rounded p-2">
                  &quot;Add a new speaker [NAME] to the voiceprint library. Find YouTube interviews with clean studio audio and extract clips.&quot;
                </p>
              </div>
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
                <p className="font-semibold text-gray-800 mb-1">Reference:</p>
                <p className="text-xs text-gray-600">
                  The full extraction workflow is documented in<br />
                  <code className="bg-gray-200 px-1 rounded">/memories/repo/voiceprint-clip-extraction.md</code>
                </p>
              </div>
              <p className="text-xs text-gray-500">
                The AI will search YouTube for studio interviews (avoiding rallies/crowds),
                download via the satellite server, extract 10-second clips at 16kHz, and upload them here for your review.
              </p>
            </div>
            <button
              onClick={() => setShowNewSpeaker(false)}
              className="mt-4 w-full py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium text-gray-700 transition-colors"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-2xl font-bold text-gray-900">🎤 Voiceprint Library</h2>
          <button
            onClick={() => setShowNewSpeaker(true)}
            className="px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg text-sm font-medium transition-colors border border-indigo-200"
          >
            + New Speaker
          </button>
        </div>
        <p className="text-sm text-gray-500">
          Curate speaker clips for voiceprint building. Listen, approve (👍) or reject (👎) each clip.
          Goal: 10 approved clips per speaker.
        </p>
      </div>

      {/* Speaker selector */}
      <div className="bg-white rounded-lg shadow p-4">
        <h3 className="text-sm font-semibold text-gray-700 mb-2 uppercase tracking-wide">Speakers</h3>
        {speakers.length === 0 && !error ? (
          <p className="text-gray-400 text-sm">No speakers yet. Ask the agent to add candidate clips.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {speakers.map((s) => (
              <button
                key={s.speaker}
                onClick={() => selectSpeaker(s.speaker)}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  selectedSpeaker === s.speaker
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {s.speaker}
                <span className="ml-1.5 text-xs opacity-75">
                  {s.approved}✓ / {s.total}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline">dismiss</button>
        </div>
      )}

      {/* Clips grid */}
      {selectedSpeaker && (
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-lg font-bold text-gray-900 capitalize">{selectedSpeaker}</h3>
              <p className="text-xs text-gray-500">
                {approvedCount} approved · {candidateCount} to review · {clips.length} total
              </p>
            </div>
            <div className="flex gap-1">
              {(['all', 'candidate', 'approved', 'rejected'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                    filter === f ? 'bg-blue-100 text-blue-700' : 'text-gray-500 hover:bg-gray-100'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          {/* Progress bar */}
          <div className="w-full bg-gray-200 rounded-full h-2 mb-4">
            <div
              className="bg-green-500 h-2 rounded-full transition-all"
              style={{ width: `${Math.min(100, (approvedCount / 10) * 100)}%` }}
            />
            <p className="text-xs text-gray-400 mt-1">{approvedCount}/10 target</p>
          </div>

          {/* Reference audio — approved clips for comparison */}
          {approvedClips.length > 0 && (
            <div className="mb-4 border border-green-200 bg-green-50 rounded-lg p-3">
              <h4 className="text-xs font-semibold text-green-800 uppercase tracking-wide mb-2">
                ✅ Reference Audio ({approvedClips.length} approved)
              </h4>
              <div className="flex flex-wrap gap-2">
                {approvedClips.map((clip) => (
                  <button
                    key={clip.clip_id}
                    onClick={() => (playingClipId === clip.clip_id ? stopAudio() : playClip(clip.clip_id))}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                      playingClipId === clip.clip_id
                        ? 'bg-green-600 text-white ring-2 ring-green-400'
                        : 'bg-white text-green-700 border border-green-300 hover:bg-green-100'
                    }`}
                    title={`${clip.source_video || ''} ${clip.timestamp_s ? `@ ${clip.timestamp_s}s` : ''}`}
                  >
                    {playingClipId === clip.clip_id ? '⏹' : '▶'} {clip.clip_id}
                  </button>
                ))}
              </div>
              <p className="text-xs text-green-600 mt-2">
                Play these to remind yourself what {selectedSpeaker} sounds like before reviewing candidates below.
              </p>
            </div>
          )}

          {loading ? (
            <p className="text-gray-400 text-sm py-8 text-center">Loading clips...</p>
          ) : filteredClips.length === 0 ? (
            <p className="text-gray-400 text-sm py-8 text-center">No clips match filter.</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {filteredClips.map((clip, i) => (
                <ClipCard
                  key={clip.clip_id}
                  clip={clip}
                  index={i}
                  onStatusChange={handleStatusChange}
                  isPlaying={playingClipId === clip.clip_id}
                  onPlay={playClip}
                  onStop={stopAudio}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
