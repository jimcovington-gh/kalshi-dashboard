'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { fetchAuthSession, signOut } from 'aws-amplify/auth';
import Link from 'next/link';

// --- Nav item types ---

interface NavLink {
  href: string;
  label: string;
  exact?: boolean;
  external?: boolean;
  base: string;
  active: string;
}

interface NavGroup {
  label: string;
  base: string;
  active: string;
  items: NavLink[];
}

type NavEntry = NavLink | NavGroup;

function isGroup(entry: NavEntry): entry is NavGroup {
  return 'items' in entry;
}

// --- Navigation config ---

const nav: NavEntry[] = [
  { href: '/dashboard', label: 'Positions', exact: true,
    base: 'text-gray-600', active: 'text-gray-900 border-blue-500' },
  { href: '/dashboard/analytics', label: 'Analytics',
    base: 'text-gray-600', active: 'text-gray-900 border-blue-500' },
  {
    label: '▸ Trading',
    base: 'text-emerald-600',
    active: 'text-emerald-700 border-emerald-500',
    items: [
      { href: '/dashboard/nfl-draft', label: '🏈 Draft Trader',
        base: 'text-amber-600', active: 'text-amber-700 bg-amber-50' },
      { href: '/dashboard/voice-trader', label: '🎙️ Voice Trader',
        base: 'text-orange-600', active: 'text-orange-700 bg-orange-50' },
      { href: '/dashboard/event-trader', label: '🎬 Event Trader',
        base: 'text-emerald-600', active: 'text-emerald-700 bg-emerald-50' },
      { href: '/dashboard/quickbets', label: '⚡ InstaButton',
        base: 'text-green-600', active: 'text-green-700 bg-green-50' },
      { href: '/dashboard/signal-engine', label: '📈 Signals',
        base: 'text-red-600', active: 'text-red-700 bg-red-50' },
    ],
  },
  {
    label: '▸ Tools',
    base: 'text-indigo-600',
    active: 'text-indigo-700 border-indigo-500',
    items: [
      { href: '/dashboard/capture', label: '📦 Capture',
        base: 'text-purple-600', active: 'text-purple-700 bg-purple-50' },
      { href: '/dashboard/satellite', label: '📡 Satellite',
        base: 'text-cyan-600', active: 'text-cyan-700 bg-cyan-50' },
      { href: '/dashboard/ai-chat', label: '🤖 AI Chat',
        base: 'text-indigo-600', active: 'text-indigo-700 bg-indigo-50' },
      { href: '/dashboard/voiceprints', label: '🎤 Voiceprints',
        base: 'text-pink-600', active: 'text-pink-700 bg-pink-50' },
      { href: 'https://voice.apexmarkets.us/test', label: '🧪 Test Bench',
        external: true,
        base: 'text-yellow-600', active: 'text-yellow-700 bg-yellow-50' },
    ],
  },
  { href: '/dashboard/admin', label: 'Control',
    base: 'text-blue-600', active: 'text-blue-700 border-blue-500' },
];

// --- Dropdown component ---

function NavDropdown({ group, pathname }: { group: NavGroup; pathname: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const anyChildActive = group.items.some(item =>
    item.exact ? pathname === item.href : pathname.startsWith(item.href)
  );
  const activeChild = group.items.find(item =>
    item.exact ? pathname === item.href : pathname.startsWith(item.href)
  );

  // Close on outside click
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const handleEnter = useCallback(() => {
    if (timeout.current) clearTimeout(timeout.current);
    setOpen(true);
  }, []);

  const handleLeave = useCallback(() => {
    timeout.current = setTimeout(() => setOpen(false), 150);
  }, []);

  return (
    <div ref={ref} className="relative h-full flex items-end" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`px-3 py-2 text-xs md:text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
          anyChildActive
            ? group.active
            : `${group.base} border-transparent hover:text-gray-900 hover:border-gray-300`
        }`}
      >
        {anyChildActive && activeChild ? activeChild.label : group.label}
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-px bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[180px] z-50">
          {group.items.map(item => {
            const isActive = item.exact ? pathname === item.href : pathname.startsWith(item.href);
            if (item.external) {
              return (
                <a
                  key={item.href}
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`block px-4 py-2 text-sm font-medium transition-colors ${
                    item.base
                  } hover:bg-gray-50`}
                  onClick={() => setOpen(false)}
                >
                  {item.label} ↗
                </a>
              );
            }
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block px-4 py-2 text-sm font-medium transition-colors ${
                  isActive ? item.active : `${item.base} hover:bg-gray-50`
                }`}
                onClick={() => setOpen(false)}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [user, setUser] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      const session = await fetchAuthSession();
      const preferredUsername = session.tokens?.idToken?.payload['preferred_username'] as string;
      const email = session.tokens?.idToken?.payload['email'] as string;
      const displayName = preferredUsername || (email ? email.split('@')[0] : 'User');
      setUser(displayName);
      setIsLoading(false);
    } catch {
      router.push('/');
    }
  }

  async function handleSignOut() {
    try {
      await signOut();
      router.push('/');
    } catch (error) {
      console.error('Error signing out:', error);
    }
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-lg">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-3 sm:px-4 lg:px-8">
          <div className="flex justify-between h-12">
            <div className="flex items-center">
              <Link href="/dashboard" className="text-base font-bold text-blue-600 mr-4 md:mr-6 shrink-0">
                📊 <span className="hidden sm:inline">Kalshi</span>
              </Link>
              <div className="flex items-end h-full -mb-px">
                {nav.map((entry, i) => {
                  if (isGroup(entry)) {
                    return <NavDropdown key={i} group={entry} pathname={pathname} />;
                  }
                  const isActive = entry.exact
                    ? pathname === entry.href
                    : pathname.startsWith(entry.href);
                  return (
                    <Link
                      key={entry.href}
                      href={entry.href}
                      className={`px-3 py-2 text-xs md:text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                        isActive
                          ? entry.active
                          : `${entry.base} border-transparent hover:text-gray-900 hover:border-gray-300`
                      }`}
                    >
                      {entry.label}
                    </Link>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center space-x-2 md:space-x-4 shrink-0">
              <div className="text-xs md:text-sm text-gray-600">
                <span className="hidden sm:inline">{user}</span>
              </div>
              <button
                onClick={handleSignOut}
                className="px-2 md:px-3 py-1 text-xs md:text-sm font-medium text-gray-500 hover:text-gray-700"
              >
                <span className="hidden sm:inline">Sign Out</span>
                <span className="sm:hidden">Exit</span>
              </button>
            </div>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-3 sm:px-4 lg:px-8 py-4 md:py-6">
        {children}
      </main>
    </div>
  );
}
