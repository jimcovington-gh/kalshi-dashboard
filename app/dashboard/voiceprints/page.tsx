'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getVoiceprintSpeakers,
  getVoiceprintClips,
  updateVoiceprintClipStatus,
  searchYouTube,
  extractVoiceprintClip,
  VoiceprintSpeaker,
  VoiceprintClip,
  YouTubeSearchResult,
} from '@/lib/api';

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: (() => void) | undefined;
  }
}

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
  const sourceLabel = clip.source_video ? clip.source_video : '';
  const timeLabel = clip.timestamp_s ? `@ ${Math.floor(clip.timestamp_s / 60)}:${String(clip.timestamp_s % 60).padStart(2, '0')}` : '';

  return (
    <div
      className={`border rounded-lg p-3 transition-all ${
        isPlaying
          ? 'border-blue-400 bg-blue-50 ring-2 ring-blue-400 shadow-lg shadow-blue-200'
          : clip.status === 'approved'
          ? 'border-green-300 bg-green-50'
          : clip.status === 'rejected'
          ? 'border-red-200 bg-red-50 opacity-60'
          : 'border-gray-200 bg-white'
      }`}
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
  // ── Speaker state ──
  const [speakers, setSpeakers] = useState<VoiceprintSpeaker[]>([]);
  const [selectedSpeaker, setSelectedSpeaker] = useState<string>('');
  const [newSpeakerName, setNewSpeakerName] = useState('');

  // ── Video search & player state ──
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<YouTubeSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState<YouTubeSearchResult | null>(null);
  const playerRef = useRef<any>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const [playerReady, setPlayerReady] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const timeUpdateRef = useRef<NodeJS.Timeout | null>(null);

  // ── Clip extraction state ──
  const [extracting, setExtracting] = useState(false);
  const [extractStatus, setExtractStatus] = useState('');

  // ── Clips curation state ──
  const [clips, setClips] = useState<VoiceprintClip[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [playingClipId, setPlayingClipId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'candidate' | 'approved' | 'rejected'>('all');
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // ── Load YouTube IFrame API ──
  useEffect(() => {
    if (window.YT && window.YT.Player) return;
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
    return () => { stopAudio(); stopTimeUpdater(); };
  }, []);

  // ── Load speakers on mount ──
  useEffect(() => { loadSpeakers(); }, []);

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
    // Pre-fill search with speaker name
    setSearchQuery(`${speaker} interview`);
  }

  function addNewSpeaker() {
    const name = newSpeakerName.trim().toLowerCase();
    if (!name) return;
    setSelectedSpeaker(name);
    setNewSpeakerName('');
    setClips([]);
    setSearchQuery(`${name} interview`);
  }

  // ── YouTube Search ──
  async function handleSearch() {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setError('');
    try {
      const data = await searchYouTube(searchQuery.trim());
      setSearchResults(data.results);
    } catch (err: any) {
      setError(err.message || 'Search failed');
    } finally {
      setSearching(false);
    }
  }

  // ── YouTube Player ──
  function loadVideo(video: YouTubeSearchResult) {
    setSelectedVideo(video);
    setPlayerReady(false);
    setCurrentTime(0);

    // Destroy existing player
    if (playerRef.current) {
      try { playerRef.current.destroy(); } catch {}
      playerRef.current = null;
    }

    // Wait for YT API
    const initPlayer = () => {
      if (!playerContainerRef.current) return;
      // Clear the container and create a fresh div
      playerContainerRef.current.innerHTML = '<div id="yt-player"></div>';

      playerRef.current = new window.YT.Player('yt-player', {
        height: '360',
        width: '640',
        videoId: video.video_id,
        playerVars: {
          autoplay: 1,
          modestbranding: 1,
          rel: 0,
        },
        events: {
          onReady: () => {
            setPlayerReady(true);
            startTimeUpdater();
          },
        },
      });
    };

    if (window.YT && window.YT.Player) {
      initPlayer();
    } else {
      window.onYouTubeIframeAPIReady = initPlayer;
    }
  }

  function startTimeUpdater() {
    stopTimeUpdater();
    timeUpdateRef.current = setInterval(() => {
      if (playerRef.current && typeof playerRef.current.getCurrentTime === 'function') {
        setCurrentTime(playerRef.current.getCurrentTime());
      }
    }, 250);
  }

  function stopTimeUpdater() {
    if (timeUpdateRef.current) {
      clearInterval(timeUpdateRef.current);
      timeUpdateRef.current = null;
    }
  }

  function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // ── Clip Extraction ──
  async function handleMarkClip() {
    if (!selectedSpeaker || !selectedVideo || !playerRef.current) return;

    const endTime = playerRef.current.getCurrentTime();
    const startS = Math.max(0, endTime - 10);

    setExtracting(true);
    setExtractStatus(`Extracting ${formatTime(startS)} → ${formatTime(startS + 10)}...`);

    try {
      const result = await extractVoiceprintClip({
        video_url: `https://www.youtube.com/watch?v=${selectedVideo.video_id}`,
        video_id: selectedVideo.video_id,
        video_title: selectedVideo.title,
        start_s: startS,
        speaker: selectedSpeaker,
      });

      if (result.status === 'already_exists') {
        setExtractStatus(`⚠️ Clip already exists (${result.existing_status})`);
      } else {
        setExtractStatus(`✓ Clip extracted: ${formatTime(startS)} → ${formatTime(startS + 10)}`);
        // Reload clips to show the new one
        loadClips(selectedSpeaker);
        loadSpeakers();
      }
    } catch (err: any) {
      setExtractStatus(`✗ Error: ${err.message || 'extraction failed'}`);
    } finally {
      setExtracting(false);
      setTimeout(() => setExtractStatus(''), 5000);
    }
  }

  // ── Clip Curation ──
  async function handleStatusChange(clipId: string, newStatus: 'approved' | 'rejected' | 'candidate') {
    try {
      await updateVoiceprintClipStatus(selectedSpeaker, clipId, newStatus);
      setClips((prev) =>
        prev.map((c) => (c.clip_id === clipId ? { ...c, status: newStatus } : c))
      );
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
    audio.onerror = () => { setPlayingClipId(null); setError('Failed to play audio'); };
    audio.play();
  }

  const approvedClips = clips.filter((c) => c.status === 'approved');
  const filteredClips = filter === 'all' ? clips : clips.filter((c) => c.status === filter);
  const approvedCount = approvedClips.length;
  const candidateCount = clips.filter((c) => c.status === 'candidate').length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-white rounded-lg shadow p-4">
        <h2 className="text-2xl font-bold text-gray-900 mb-1">🎤 Voiceprint Builder</h2>
        <p className="text-sm text-gray-500">
          Search YouTube for speaker clips, scrub to find clean speech, extract 10-second samples.
          Approve 10+ clips then build a voiceprint.
        </p>
      </div>

      {/* Speaker selector */}
      <div className="bg-white rounded-lg shadow p-4">
        <h3 className="text-sm font-semibold text-gray-700 mb-2 uppercase tracking-wide">Speaker</h3>
        <div className="flex flex-wrap gap-2 mb-3">
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
        {/* New speaker input */}
        <div className="flex gap-2">
          <input
            type="text"
            value={newSpeakerName}
            onChange={(e) => setNewSpeakerName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addNewSpeaker()}
            placeholder="New speaker name..."
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
          />
          <button
            onClick={addNewSpeaker}
            disabled={!newSpeakerName.trim()}
            className="px-4 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg text-sm font-medium border border-indigo-200 disabled:opacity-50"
          >
            + Add
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline">dismiss</button>
        </div>
      )}

      {/* YouTube Search + Player */}
      {selectedSpeaker && (
        <div className="bg-white rounded-lg shadow p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-2 uppercase tracking-wide">
            Find Clips for <span className="capitalize text-blue-600">{selectedSpeaker}</span>
          </h3>

          {/* Search bar */}
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder={`Search YouTube for ${selectedSpeaker}...`}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
            />
            <button
              onClick={handleSearch}
              disabled={searching || !searchQuery.trim()}
              className="px-4 py-2 bg-red-50 hover:bg-red-100 text-red-700 rounded-lg text-sm font-medium border border-red-200 disabled:opacity-50"
            >
              {searching ? 'Searching...' : '🔍 Search YouTube'}
            </button>
          </div>

          {/* Search results */}
          {searchResults.length > 0 && (
            <div className="mb-4">
              <p className="text-xs text-gray-500 mb-2">{searchResults.length} results — click to load</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-64 overflow-y-auto">
                {searchResults.map((r) => (
                  <button
                    key={r.video_id}
                    onClick={() => loadVideo(r)}
                    className={`flex gap-2 p-2 rounded-lg text-left transition-colors border ${
                      selectedVideo?.video_id === r.video_id
                        ? 'border-blue-400 bg-blue-50'
                        : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    {r.thumbnail && (
                      <img src={r.thumbnail} alt="" className="w-24 h-16 rounded object-cover flex-shrink-0" />
                    )}
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-gray-900 line-clamp-2">{r.title}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {r.channel} · {r.duration}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* YouTube Player + Extract Controls */}
          {selectedVideo && (
            <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
              <div className="flex gap-4">
                {/* Player */}
                <div ref={playerContainerRef} className="flex-shrink-0">
                  <div id="yt-player" />
                </div>

                {/* Extract controls */}
                <div className="flex-1 flex flex-col justify-center">
                  <p className="text-sm font-medium text-gray-900 mb-1 line-clamp-2">{selectedVideo.title}</p>
                  <p className="text-xs text-gray-500 mb-4">{selectedVideo.channel} · {selectedVideo.duration}</p>

                  {/* Current position */}
                  <div className="bg-white rounded-lg p-3 border border-gray-200 mb-3">
                    <p className="text-xs text-gray-500 mb-1">Current position</p>
                    <p className="text-2xl font-mono font-bold text-gray-900">{formatTime(currentTime)}</p>
                    {currentTime >= 10 ? (
                      <p className="text-xs text-green-600 mt-1">
                        Will extract: {formatTime(currentTime - 10)} → {formatTime(currentTime)}
                      </p>
                    ) : (
                      <p className="text-xs text-orange-600 mt-1">
                        Scrub past 0:10 to mark a full 10s clip
                      </p>
                    )}
                  </div>

                  {/* Mark clip button */}
                  <button
                    onClick={handleMarkClip}
                    disabled={extracting || !playerReady || currentTime < 10}
                    className={`w-full py-3 rounded-lg text-base font-bold transition-colors ${
                      extracting
                        ? 'bg-yellow-100 text-yellow-800 border border-yellow-300'
                        : currentTime >= 10
                        ? 'bg-green-600 text-white hover:bg-green-700 shadow-lg shadow-green-200'
                        : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                    }`}
                  >
                    {extracting ? '⏳ Extracting...' : '✂️ Mark Clip (last 10 seconds)'}
                  </button>

                  {extractStatus && (
                    <p className={`text-sm mt-2 ${
                      extractStatus.startsWith('✓') ? 'text-green-600' :
                      extractStatus.startsWith('⚠') ? 'text-yellow-600' :
                      extractStatus.startsWith('✗') ? 'text-red-600' :
                      'text-blue-600'
                    }`}>
                      {extractStatus}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Clips grid */}
      {selectedSpeaker && clips.length > 0 && (
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-lg font-bold text-gray-900 capitalize">{selectedSpeaker} — Clips</h3>
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
                    {playingClipId === clip.clip_id ? '⏹' : '▶'} {clip.clip_id.slice(0, 8)}
                  </button>
                ))}
              </div>
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
