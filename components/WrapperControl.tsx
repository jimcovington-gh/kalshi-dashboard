'use client';

import { useState, useEffect } from 'react';
import { get, post } from 'aws-amplify/api';
import { fetchAuthSession } from 'aws-amplify/auth';

interface WrapperStatus {
  control_service?: {
    status: string;
    port: number;
    pid?: number;
  };
  wrapper_service?: {
    status: string;
    endpoint: string;
    port: number;
    error?: string;
  };
  timestamp?: string;
}

interface ControlResult {
  action: string;
  status: string;
  message?: string;
  error?: string;
  output?: string;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export function WrapperControl() {
  const [status, setStatus] = useState<WrapperStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [controlling, setControlling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  // Fetch status on mount and every 15 seconds
  useEffect(() => {
    let recoveryAttempts = 0;
    const maxRecoveryAttempts = 3;

    const fetchStatus = async () => {
      try {
        const headers = await getAuthHeaders();
        const op = get({
          apiName: 'DashboardAPI',
          path: '/wrapper/status',
          options: { headers },
        });
        const resp = await op.response;
        const data = await resp.body.json() as any;

        setStatus(data.status || data);
        setLastUpdate(new Date());
        setError(null);
        recoveryAttempts = 0;
      } catch (err) {
        if (recoveryAttempts < maxRecoveryAttempts) {
          recoveryAttempts++;
          setError(`Recovering... attempt ${recoveryAttempts}/${maxRecoveryAttempts}`);
        } else {
          setError('Control service not responding. It should auto-restart.');
        }
      } finally {
        setLoading(false);
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 15000);
    return () => clearInterval(interval);
  }, []);

  const handleControl = async (action: 'start' | 'stop' | 'restart') => {
    setControlling(action);
    setError(null);

    try {
      const headers = await getAuthHeaders();
      const op = post({
        apiName: 'DashboardAPI',
        path: `/wrapper/${action}`,
        options: { headers, body: {} as any },
      });
      const resp = await op.response;
      const data = await resp.body.json() as any;

      // data = { control: { action, status, message, output } }
      const result: ControlResult = data.control || data;

      if (result.status === 'success' || result.status === 'already_running') {
        // Give the wrapper time to boot before refreshing status
        const waitTime = (action === 'start' || action === 'restart') && result.status === 'success' ? 3000 : 500;
        await new Promise(resolve => setTimeout(resolve, waitTime));

        // Refresh status
        const statusHeaders = await getAuthHeaders();
        const statusOp = get({
          apiName: 'DashboardAPI',
          path: '/wrapper/status',
          options: { headers: statusHeaders },
        });
        const statusResp = await statusOp.response;
        const statusData = await statusResp.body.json() as any;
        setStatus(statusData.status || statusData);
        setLastUpdate(new Date());
      } else {
        setError(result.error || result.message || `Failed to ${action} wrapper`);
      }
    } catch (err: any) {
      // Extract meaningful error from Amplify's error structure
      const msg = err?.response?.statusText || err?.message || 'Unknown error';
      setError(`Error: ${msg}`);
    } finally {
      setControlling(null);
    }
  };

  const wrapperHealthy = status?.wrapper_service?.status === 'healthy';
  const controlReady = status?.control_service?.status === 'running';

  return (
    <div className="bg-white rounded-lg shadow p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Copilot Chat Wrapper</h2>
        <div className="flex items-center gap-2">
          <div
            className={`w-3 h-3 rounded-full ${
              wrapperHealthy ? 'bg-green-500' : 'bg-red-500'
            }`}
          />
          <span className="text-sm font-medium">
            {wrapperHealthy ? 'Healthy' : 'Down'}
          </span>
        </div>
      </div>

      {/* Status Information */}
      <div className="bg-gray-50 rounded p-3 space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-600">Wrapper Status:</span>
          <span className="font-mono">
            {status?.wrapper_service?.status || 'unknown'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-600">Endpoint:</span>
          <span className="font-mono text-xs">
            {status?.wrapper_service?.endpoint || 'N/A'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-600">Control Service:</span>
          <span className="font-mono">
            {status?.control_service?.status === 'running' ? '✓ Running' : '✗ Down'}
          </span>
        </div>
        {lastUpdate && (
          <div className="flex justify-between text-xs text-gray-500">
            <span>Last Updated:</span>
            <span>{lastUpdate.toLocaleTimeString()}</span>
          </div>
        )}
      </div>

      {/* Control Buttons */}
      <div className="flex gap-2">
        <button
          onClick={() => handleControl('start')}
          disabled={controlling !== null || wrapperHealthy}
          className="flex-1 px-3 py-2 bg-green-600 text-white rounded font-medium text-sm hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {controlling === 'start' ? 'Starting...' : 'Start'}
        </button>

        <button
          onClick={() => handleControl('stop')}
          disabled={controlling !== null || !wrapperHealthy}
          className="flex-1 px-3 py-2 bg-red-600 text-white rounded font-medium text-sm hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {controlling === 'stop' ? 'Stopping...' : 'Stop'}
        </button>

        <button
          onClick={() => handleControl('restart')}
          disabled={controlling !== null}
          className="flex-1 px-3 py-2 bg-blue-600 text-white rounded font-medium text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {controlling === 'restart' ? 'Restarting...' : 'Restart'}
        </button>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="text-center text-sm text-gray-500">
          Loading status...
        </div>
      )}

      {/* Not Available Warning */}
      {!controlReady && !loading && (
        <div className="bg-yellow-50 border border-yellow-200 rounded p-3 text-sm text-yellow-700">
          ⚠️ Control service not available. Start the control service on the server:
          <code className="block mt-1 bg-white px-2 py-1 rounded font-mono text-xs">
            python3 /home/ubuntu/kalshi/scripts/copilot-server/control-api.py
          </code>
        </div>
      )}
    </div>
  );
}
  const [status, setStatus] = useState<WrapperStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [controlling, setControlling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  // Fetch status on mount and every 10 seconds
  useEffect(() => {
    let recoveryAttempts = 0;
    const maxRecoveryAttempts = 3;

    const fetchStatus = async () => {
      try {
        const response = await get({
          apiName: 'DefaultApi',
          path: '/wrapper/status',
        }) as any;
        
        setStatus(response.status || response);
        setLastUpdate(new Date());
        setError(null);
        recoveryAttempts = 0; // Reset on success
      } catch (err) {
        // If control service is unavailable, show recovery status and keep retrying
        if (recoveryAttempts < maxRecoveryAttempts) {
          recoveryAttempts++;
          console.log(`Status check failed, retrying (${recoveryAttempts}/${maxRecoveryAttempts})`);
          setError(`Recovering... attempt ${recoveryAttempts}/${maxRecoveryAttempts}. Control service will auto-restart if crashed.`);
        } else {
          setError('Control service not responding. It should auto-restart. If problem persists, restart manually: systemctl restart copilot-control');
        }
      } finally {
        setLoading(false);
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleControl = async (action: 'start' | 'stop' | 'restart') => {
    setControlling(action);
    setError(null);

    try {
      const response = await post({
        apiName: 'DefaultApi',
        path: `/wrapper/${action}`,
        options: {
          body: {},
        },
      }) as any;

      const result = response.control || response;
      
      // 'already_running' is a success case - wrapper is running, just refresh status
      if (result.status === 'success' || result.status === 'already_running') {
        // Wait before refreshing - wrapper needs time to boot (skip wait if already running)
        const waitTime = (action === 'start' || action === 'restart') && result.status === 'success' ? 3000 : 500;
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        // Refresh status
        try {
          const statusResponse = await get({
            apiName: 'DefaultApi',
            path: '/wrapper/status',
          }) as any;
          
          setStatus(statusResponse.status || statusResponse);
          setLastUpdate(new Date());
        } catch (err) {
          console.error('Failed to refresh status after control action:', err);
        }
      } else {
        // result.status === 'failed'
        setError(result.error || result.message || `Failed to ${action} wrapper`);
      }
    } catch (err) {
      setError(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setControlling(null);
    }
  };

  const wrapperHealthy = status?.wrapper_service?.status === 'healthy';
  const controlReady = status?.control_service?.status === 'running';

  return (
    <div className="bg-white rounded-lg shadow p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Copilot Chat Wrapper</h2>
        <div className="flex items-center gap-2">
          <div
            className={`w-3 h-3 rounded-full ${
              wrapperHealthy ? 'bg-green-500' : 'bg-red-500'
            }`}
          />
          <span className="text-sm font-medium">
            {wrapperHealthy ? 'Healthy' : 'Down'}
          </span>
        </div>
      </div>

      {/* Status Information */}
      <div className="bg-gray-50 rounded p-3 space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-600">Wrapper Status:</span>
          <span className="font-mono">
            {status?.wrapper_service?.status || 'unknown'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-600">Endpoint:</span>
          <span className="font-mono text-xs">
            {status?.wrapper_service?.endpoint || 'N/A'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-600">Control Service:</span>
          <span className="font-mono">
            {status?.control_service?.status === 'running' ? '✓ Running' : '✗ Down'}
          </span>
        </div>
        {lastUpdate && (
          <div className="flex justify-between text-xs text-gray-500">
            <span>Last Updated:</span>
            <span>{lastUpdate.toLocaleTimeString()}</span>
          </div>
        )}
      </div>

      {/* Control Buttons */}
      <div className="flex gap-2">
        <button
          onClick={() => handleControl('start')}
          disabled={controlling !== null || wrapperHealthy}
          className="flex-1 px-3 py-2 bg-green-600 text-white rounded font-medium text-sm hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {controlling === 'start' ? 'Starting...' : 'Start'}
        </button>

        <button
          onClick={() => handleControl('stop')}
          disabled={controlling !== null || !wrapperHealthy}
          className="flex-1 px-3 py-2 bg-red-600 text-white rounded font-medium text-sm hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {controlling === 'stop' ? 'Stopping...' : 'Stop'}
        </button>

        <button
          onClick={() => handleControl('restart')}
          disabled={controlling !== null}
          className="flex-1 px-3 py-2 bg-blue-600 text-white rounded font-medium text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {controlling === 'restart' ? 'Restarting...' : 'Restart'}
        </button>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="text-center text-sm text-gray-500">
          Loading status...
        </div>
      )}

      {/* Not Available Warning */}
      {!controlReady && !loading && (
        <div className="bg-yellow-50 border border-yellow-200 rounded p-3 text-sm text-yellow-700">
          ⚠️ Control service not available. Start the control service on the server:
          <code className="block mt-1 bg-white px-2 py-1 rounded font-mono text-xs">
            python3 /home/ubuntu/kalshi/scripts/copilot-server/control-api.py
          </code>
        </div>
      )}
    </div>
  );
}
