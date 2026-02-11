'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { 
  isAdmin, 
  listDevices, 
  generateDeviceToken, 
  revokeDeviceToken, 
  getSecurityAudit,
  DeviceToken,
  SecurityAuditEntry 
} from '@/lib/api';

export default function DeviceManagementPage() {
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isAdminUser, setIsAdminUser] = useState(false);
  const [loading, setLoading] = useState(true);
  
  // Devices state
  const [devices, setDevices] = useState<DeviceToken[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  
  // Generate token state
  const [showGenerateForm, setShowGenerateForm] = useState(false);
  const [newUserName, setNewUserName] = useState('');
  const [newDeviceName, setNewDeviceName] = useState('');
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  
  // Revoke state
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  
  // Security audit state
  const [auditEntries, setAuditEntries] = useState<SecurityAuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditDays, setAuditDays] = useState(7);
  
  const router = useRouter();

  useEffect(() => {
    checkAdminAndLoad();
  }, []);

  async function checkAdminAndLoad() {
    try {
      const adminStatus = await isAdmin();
      if (!adminStatus) {
        router.push('/dashboard');
        return;
      }
      setIsAdminUser(true);
      await Promise.all([loadDevices(), loadSecurityAudit()]);
    } catch (err: any) {
      setError('Access denied');
      setTimeout(() => router.push('/dashboard'), 2000);
    } finally {
      setLoading(false);
    }
  }

  async function loadDevices() {
    setDevicesLoading(true);
    try {
      const response = await listDevices();
      setDevices(response.devices);
    } catch (err: any) {
      setError('Failed to load devices');
    } finally {
      setDevicesLoading(false);
    }
  }

  async function loadSecurityAudit() {
    setAuditLoading(true);
    try {
      const response = await getSecurityAudit(auditDays);
      setAuditEntries(response.failed_attempts);
    } catch (err: any) {
      console.error('Failed to load security audit:', err);
    } finally {
      setAuditLoading(false);
    }
  }

  async function handleGenerateToken() {
    if (!newUserName.trim() || !newDeviceName.trim()) {
      setError('User name and device name are required');
      return;
    }
    
    setGenerating(true);
    setError('');
    try {
      const response = await generateDeviceToken(newUserName.trim(), newDeviceName.trim());
      setGeneratedToken(response.token);
      setSuccess('Token generated! Copy it now - it will not be shown again.');
      await loadDevices();
    } catch (err: any) {
      setError(err.message || 'Failed to generate token');
    } finally {
      setGenerating(false);
    }
  }

  async function handleRevokeToken(tokenPartial: string) {
    setRevoking(tokenPartial);
    setError('');
    try {
      await revokeDeviceToken(tokenPartial);
      setSuccess('Token revoked successfully');
      setConfirmRevoke(null);
      await loadDevices();
    } catch (err: any) {
      setError(err.message || 'Failed to revoke token');
    } finally {
      setRevoking(null);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    setSuccess('Token copied to clipboard!');
    setTimeout(() => setSuccess(''), 3000);
  }

  function formatDate(dateStr: string | null): string {
    if (!dateStr) return 'Never';
    try {
      return new Date(dateStr).toLocaleString();
    } catch {
      return dateStr;
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-6 flex items-center justify-center">
        <div className="text-xl">Loading...</div>
      </div>
    );
  }

  if (!isAdminUser) {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-6 flex items-center justify-center">
        <div className="text-xl text-red-400">{error || 'Access denied'}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <Link href="/dashboard/admin" className="text-blue-400 hover:text-blue-300 text-sm mb-2 block">
              ← Back to Admin
            </Link>
            <h1 className="text-3xl font-bold">Device Management</h1>
            <p className="text-gray-400 mt-1">Manage device tokens for Copilot proxy access</p>
          </div>
          <button
            onClick={() => {
              setShowGenerateForm(true);
              setGeneratedToken(null);
              setNewUserName('');
              setNewDeviceName('');
            }}
            className="bg-green-600 hover:bg-green-700 px-4 py-2 rounded font-medium"
          >
            + Generate Token
          </button>
        </div>

        {/* Alerts */}
        {error && (
          <div className="bg-red-900/50 border border-red-700 text-red-200 px-4 py-3 rounded mb-4">
            {error}
            <button onClick={() => setError('')} className="float-right text-red-400 hover:text-red-200">×</button>
          </div>
        )}
        {success && (
          <div className="bg-green-900/50 border border-green-700 text-green-200 px-4 py-3 rounded mb-4">
            {success}
            <button onClick={() => setSuccess('')} className="float-right text-green-400 hover:text-green-200">×</button>
          </div>
        )}

        {/* Generate Token Modal */}
        {showGenerateForm && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
              <h2 className="text-xl font-bold mb-4">Generate New Device Token</h2>
              
              {generatedToken ? (
                <div>
                  <p className="text-yellow-400 mb-4 text-sm">
                    ⚠️ Copy this token now! It will not be shown again.
                  </p>
                  <div className="bg-gray-900 p-4 rounded mb-4 font-mono text-lg text-center">
                    {generatedToken}
                  </div>
                  <button
                    onClick={() => copyToClipboard(generatedToken)}
                    className="w-full bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded mb-2"
                  >
                    Copy to Clipboard
                  </button>
                  <button
                    onClick={() => {
                      setShowGenerateForm(false);
                      setGeneratedToken(null);
                    }}
                    className="w-full bg-gray-600 hover:bg-gray-700 px-4 py-2 rounded"
                  >
                    Done
                  </button>
                </div>
              ) : (
                <div>
                  <div className="mb-4">
                    <label className="block text-sm font-medium mb-1">User Name</label>
                    <select
                      value={newUserName}
                      onChange={(e) => setNewUserName(e.target.value)}
                      className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2"
                    >
                      <option value="">Select user...</option>
                      <option value="jimc">jimc</option>
                      <option value="andrew">andrew</option>
                    </select>
                  </div>
                  <div className="mb-4">
                    <label className="block text-sm font-medium mb-1">Device Name</label>
                    <input
                      type="text"
                      value={newDeviceName}
                      onChange={(e) => setNewDeviceName(e.target.value)}
                      placeholder="e.g., Jim's iPhone"
                      className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleGenerateToken}
                      disabled={generating || !newUserName || !newDeviceName}
                      className="flex-1 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 px-4 py-2 rounded"
                    >
                      {generating ? 'Generating...' : 'Generate'}
                    </button>
                    <button
                      onClick={() => setShowGenerateForm(false)}
                      className="flex-1 bg-gray-600 hover:bg-gray-700 px-4 py-2 rounded"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Devices Table */}
        <div className="bg-gray-800 rounded-lg p-6 mb-6">
          <h2 className="text-xl font-bold mb-4">Registered Devices</h2>
          {devicesLoading ? (
            <div className="text-gray-400">Loading devices...</div>
          ) : devices.length === 0 ? (
            <div className="text-gray-400">No devices registered yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left border-b border-gray-700">
                    <th className="pb-3 pr-4">Token</th>
                    <th className="pb-3 pr-4">User</th>
                    <th className="pb-3 pr-4">Device</th>
                    <th className="pb-3 pr-4">Created</th>
                    <th className="pb-3 pr-4">Last Used</th>
                    <th className="pb-3 pr-4">Status</th>
                    <th className="pb-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {devices.map((device) => (
                    <tr key={device.token_partial} className="border-b border-gray-700/50">
                      <td className="py-3 pr-4 font-mono text-sm">{device.token_partial}</td>
                      <td className="py-3 pr-4">{device.user_name}</td>
                      <td className="py-3 pr-4">{device.device_name}</td>
                      <td className="py-3 pr-4 text-sm text-gray-400">
                        {formatDate(device.created_at)}
                        <br />
                        <span className="text-xs">by {device.created_by}</span>
                      </td>
                      <td className="py-3 pr-4 text-sm text-gray-400">
                        {formatDate(device.last_used_at)}
                      </td>
                      <td className="py-3 pr-4">
                        {device.revoked ? (
                          <span className="bg-red-900/50 text-red-300 px-2 py-1 rounded text-sm">
                            Revoked
                          </span>
                        ) : (
                          <span className="bg-green-900/50 text-green-300 px-2 py-1 rounded text-sm">
                            Active
                          </span>
                        )}
                      </td>
                      <td className="py-3">
                        {!device.revoked && (
                          confirmRevoke === device.token_partial ? (
                            <div className="flex gap-2">
                              <button
                                onClick={() => handleRevokeToken(device.token_partial)}
                                disabled={revoking === device.token_partial}
                                className="text-red-400 hover:text-red-300 text-sm"
                              >
                                {revoking === device.token_partial ? 'Revoking...' : 'Confirm'}
                              </button>
                              <button
                                onClick={() => setConfirmRevoke(null)}
                                className="text-gray-400 hover:text-gray-300 text-sm"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setConfirmRevoke(device.token_partial)}
                              className="text-red-400 hover:text-red-300 text-sm"
                            >
                              Revoke
                            </button>
                          )
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Security Audit Log */}
        <div className="bg-gray-800 rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold">Security Audit Log</h2>
            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-400">Days:</label>
              <select
                value={auditDays}
                onChange={(e) => {
                  setAuditDays(parseInt(e.target.value));
                  loadSecurityAudit();
                }}
                className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm"
              >
                <option value={1}>1</option>
                <option value={7}>7</option>
                <option value={30}>30</option>
                <option value={90}>90</option>
              </select>
              <button
                onClick={loadSecurityAudit}
                disabled={auditLoading}
                className="bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded text-sm"
              >
                {auditLoading ? 'Loading...' : 'Refresh'}
              </button>
            </div>
          </div>
          
          {auditLoading ? (
            <div className="text-gray-400">Loading audit log...</div>
          ) : auditEntries.length === 0 ? (
            <div className="text-gray-400">No failed authentication attempts in the last {auditDays} days. 🎉</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left border-b border-gray-700">
                    <th className="pb-3 pr-4">Time</th>
                    <th className="pb-3 pr-4">Reason</th>
                    <th className="pb-3 pr-4">User</th>
                    <th className="pb-3 pr-4">Token</th>
                    <th className="pb-3 pr-4">IP Address</th>
                  </tr>
                </thead>
                <tbody>
                  {auditEntries.map((entry, idx) => (
                    <tr key={idx} className="border-b border-gray-700/50">
                      <td className="py-3 pr-4 text-sm">{formatDate(entry.timestamp)}</td>
                      <td className="py-3 pr-4">
                        <span className={`px-2 py-1 rounded text-sm ${
                          entry.reason === 'unknown_token' ? 'bg-orange-900/50 text-orange-300' :
                          entry.reason === 'revoked_token' ? 'bg-red-900/50 text-red-300' :
                          entry.reason === 'token_user_mismatch' ? 'bg-purple-900/50 text-purple-300' :
                          'bg-gray-700 text-gray-300'
                        }`}>
                          {entry.reason.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="py-3 pr-4">{entry.user_name || '-'}</td>
                      <td className="py-3 pr-4 font-mono text-sm">{entry.device_token_partial || '-'}</td>
                      <td className="py-3 pr-4 text-sm text-gray-400">{entry.ip_address}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
