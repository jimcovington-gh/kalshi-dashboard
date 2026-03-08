'use client';

import { useState, useEffect } from 'react';
import { get, post } from 'aws-amplify/api';

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
  wrapper_status?: {
    status: string;
    endpoint: string;
    port: number;
  };
}

export function WrapperControl() {
  const [status, setStatus] = useState<WrapperStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [controlling, setControlling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  // Fetch status on mount and every 10 seconds
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const response = await get({
          apiName: 'DefaultApi',
          path: '/wrapper/status',
        }) as any;
        
        setStatus(response.status || response);
        setLastUpdate(new Date());
        setError(null);
      } catch (err) {
        setError('Could not connect to wrapper service');
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
      
      if (result.status === 'success') {
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
        setError(result.error || `Failed to ${action} wrapper`);
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
