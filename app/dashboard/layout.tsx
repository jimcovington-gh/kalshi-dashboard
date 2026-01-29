'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { fetchAuthSession, signOut } from 'aws-amplify/auth';
import { isAdmin } from '@/lib/api';
import Link from 'next/link';

// Tab configuration - using full class names for Tailwind JIT compatibility
const tabs = [
  { href: '/dashboard', label: 'Positions', exact: true, 
    base: 'text-gray-600', active: 'text-gray-900 border-blue-500' },
  { href: '/dashboard/analytics', label: 'Analytics', 
    base: 'text-gray-600', active: 'text-gray-900 border-blue-500' },
  { href: '/dashboard/capture', label: 'Capture', 
    base: 'text-purple-600', active: 'text-purple-700 border-purple-500' },
  { href: '/dashboard/quickbets', label: 'InstaButton', 
    base: 'text-green-600', active: 'text-green-700 border-green-500' },
  { href: '/dashboard/voice-trader', label: '🎙️ Voice', 
    base: 'text-orange-600', active: 'text-orange-700 border-orange-500' },
  { href: '/dashboard/ai-chat', label: '🤖 AI', 
    base: 'text-indigo-600', active: 'text-indigo-700 border-indigo-500' },
];

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [user, setUser] = useState<string>('');
  const [isAdminUser, setIsAdminUser] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      const session = await fetchAuthSession();
      // Use preferred_username (the trading system user_name) if available, otherwise fall back to email prefix
      const preferredUsername = session.tokens?.idToken?.payload['preferred_username'] as string;
      const email = session.tokens?.idToken?.payload['email'] as string;
      const displayName = preferredUsername || (email ? email.split('@')[0] : 'User');
      setUser(displayName);
      const adminStatus = await isAdmin();
      setIsAdminUser(adminStatus);
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
      {/* Navigation - Tab Style */}
      <nav className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-3 sm:px-4 lg:px-8">
          <div className="flex justify-between h-12">
            <div className="flex items-center">
              <Link href="/dashboard" className="text-base font-bold text-blue-600 mr-4 md:mr-6 shrink-0">
                📊 <span className="hidden sm:inline">Kalshi</span>
              </Link>
              <div className="flex items-end h-full -mb-px overflow-x-auto">
                {tabs.map((tab) => {
                  const isActive = tab.exact 
                    ? pathname === tab.href 
                    : pathname.startsWith(tab.href);
                  
                  return (
                    <Link
                      key={tab.href}
                      href={tab.href}
                      className={`px-3 py-2 text-xs md:text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                        isActive 
                          ? tab.active 
                          : `${tab.base} border-transparent hover:text-gray-900 hover:border-gray-300`
                      }`}
                    >
                      {tab.label}
                    </Link>
                  );
                })}
                <a
                  href="https://voice.apexmarkets.us:8080/test"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-2 text-xs md:text-sm font-medium text-yellow-600 border-b-2 border-transparent hover:text-yellow-800 hover:border-yellow-300 whitespace-nowrap"
                >
                  🧪 Test
                </a>
                {isAdminUser && (
                  <Link
                    href="/dashboard/admin"
                    className={`px-3 py-2 text-xs md:text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                      pathname === '/dashboard/admin'
                        ? 'text-blue-700 border-blue-500'
                        : 'text-blue-600 border-transparent hover:text-blue-800 hover:border-blue-300'
                    }`}
                  >
                    Control
                  </Link>
                )}
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

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-3 sm:px-4 lg:px-8 py-4 md:py-6">
        {children}
      </main>
    </div>
  );
}
