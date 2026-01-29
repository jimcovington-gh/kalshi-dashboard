'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fetchAuthSession, signOut } from 'aws-amplify/auth';
import { isAdmin } from '@/lib/api';
import Link from 'next/link';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [user, setUser] = useState<string>('');
  const [isAdminUser, setIsAdminUser] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();

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
      {/* Navigation */}
      <nav className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-3 sm:px-4 lg:px-8">
          <div className="flex justify-between h-14 md:h-16">
            <div className="flex items-center space-x-4 md:space-x-8">
              <Link href="/dashboard" className="text-base md:text-xl font-bold text-blue-600">
                📊 <span className="hidden sm:inline">Kalshi Dashboard</span>
              </Link>
              <div className="flex space-x-2 md:space-x-4">
                <Link
                  href="/dashboard"
                  className="px-2 md:px-3 py-1.5 md:py-2 rounded-md text-xs md:text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-100"
                >
                  Positions
                </Link>
                <Link
                  href="/dashboard/analytics"
                  className="px-2 md:px-3 py-1.5 md:py-2 rounded-md text-xs md:text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-100"
                >
                  Analytics
                </Link>
                <Link
                  href="/dashboard/capture"
                  className="px-2 md:px-3 py-1.5 md:py-2 rounded-md text-xs md:text-sm font-medium text-purple-600 hover:text-purple-800 hover:bg-purple-50"
                >
                  Capture
                </Link>
                <Link
                  href="/dashboard/quickbets"
                  className="px-2 md:px-3 py-1.5 md:py-2 rounded-md text-xs md:text-sm font-medium text-green-600 hover:text-green-800 hover:bg-green-50"
                >
                  InstaButton
                </Link>
                <Link
                  href="/dashboard/voice-trader"
                  className="px-2 md:px-3 py-1.5 md:py-2 rounded-md text-xs md:text-sm font-medium text-orange-600 hover:text-orange-800 hover:bg-orange-50"
                >
                  🎙️ Voice
                </Link>
                <Link
                  href="/dashboard/ai-chat"
                  className="px-2 md:px-3 py-1.5 md:py-2 rounded-md text-xs md:text-sm font-medium text-indigo-600 hover:text-indigo-800 hover:bg-indigo-50"
                >
                  🤖 AI
                </Link>
                <a
                  href="https://voice.apexmarkets.us:8080/test"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-2 md:px-3 py-1.5 md:py-2 rounded-md text-xs md:text-sm font-medium text-yellow-600 hover:text-yellow-800 hover:bg-yellow-50"
                >
                  🧪 Test Bench
                </a>
                {isAdminUser && (
                  <Link
                    href="/dashboard/admin"
                    className="px-2 md:px-3 py-1.5 md:py-2 rounded-md text-xs md:text-sm font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50"
                  >
                    Control
                  </Link>
                )}
              </div>
            </div>

            <div className="flex items-center space-x-2 md:space-x-4">
              <div className="text-xs md:text-sm text-gray-600">
                <span className="hidden sm:inline">{user}</span>
              </div>
              <button
                onClick={handleSignOut}
                className="px-2 md:px-4 py-1.5 md:py-2 text-xs md:text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-100 rounded-md"
              >
                <span className="hidden sm:inline">Sign Out</span>
                <span className="sm:hidden">Exit</span>
              </button>
            </div>
          </div>
        </div>
      </nav>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-3 sm:px-4 lg:px-8 py-4 md:py-8">
        {children}
      </main>
    </div>
  );
}
