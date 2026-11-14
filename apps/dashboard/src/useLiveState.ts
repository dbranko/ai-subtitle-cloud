import { useEffect, useReducer, useRef } from 'react';
import { withToken, type AppNotification, type Job, type Snapshot } from './api';

export type Connection = 'connecting' | 'live' | 'reconnecting';

export interface LiveState {
  connection: Connection;
  /** True once the first snapshot has arrived. */
  loaded: boolean;
  jobs: Record<string, Job>;
  notifications: AppNotification[];
  /** serverTime − local time, to show elapsed time correctly even if the clocks differ. */
  clockOffsetMs: number;
}

type Action =
  | { type: 'connection'; connection: Connection }
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'job'; job: Job }
  | { type: 'notification'; notification: AppNotification };

const initial: LiveState = {
  connection: 'connecting',
  loaded: false,
  jobs: {},
  notifications: [],
  clockOffsetMs: 0,
};

function reducer(state: LiveState, action: Action): LiveState {
  switch (action.type) {
    case 'connection':
      return { ...state, connection: action.connection };
    case 'snapshot': {
      // The snapshot is the truth for active jobs; finished jobs already on screen are kept.
      const jobs: Record<string, Job> = {};
      for (const job of Object.values(state.jobs)) {
        if (['completed', 'failed', 'cancelled'].includes(job.state)) jobs[job.id] = job;
      }
      for (const job of action.snapshot.jobs) jobs[job.id] = job;
      return {
        connection: 'live',
        loaded: true,
        jobs,
        notifications: action.snapshot.notifications,
        clockOffsetMs: Date.parse(action.snapshot.serverTime) - Date.now(),
      };
    }
    case 'job': {
      const known = state.jobs[action.job.id];
      // Events carry the full job; never let an older one overwrite a newer one.
      if (known && Date.parse(known.updatedAt) > Date.parse(action.job.updatedAt)) return state;
      return { ...state, jobs: { ...state.jobs, [action.job.id]: action.job } };
    }
    case 'notification': {
      const others = state.notifications.filter((n) => n.id !== action.notification.id);
      return {
        ...state,
        notifications: action.notification.read ? others : [action.notification, ...others],
      };
    }
  }
}

const JOB_EVENTS = ['job.created', 'job.updated', 'job.completed', 'job.failed', 'job.cancelled'];

export interface LiveCallbacks {
  /** A completion/failure notification the user has not been alerted to yet. */
  onNewNotification: (notification: AppNotification) => void;
}

/**
 * Live view of jobs and notifications over Server-Sent Events.
 *
 * The browser's EventSource reconnects by itself. Every (re)connection starts
 * with a snapshot, so the page shows the true current state after a refresh,
 * a network drop or a server restart — without any polling.
 */
export function useLiveState(callbacks: LiveCallbacks): LiveState {
  const [state, dispatch] = useReducer(reducer, initial);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let snapshots = 0;
    let closed = false;
    const alerted = new Set<string>();

    const connect = () => {
      source = new EventSource(withToken('/api/v1/events'));

      source.addEventListener('snapshot', (e) => {
        const snapshot = JSON.parse((e as MessageEvent<string>).data) as Snapshot;
        snapshots++;
        for (const n of snapshot.notifications) {
          // First load: existing unread notifications are shown in the list only.
          // After a reconnect: anything that finished meanwhile still alerts the user, once.
          if (snapshots > 1 && !alerted.has(n.id)) callbacksRef.current.onNewNotification(n);
          alerted.add(n.id);
        }
        dispatch({ type: 'snapshot', snapshot });
      });

      for (const name of JOB_EVENTS) {
        source.addEventListener(name, (e) => {
          dispatch({ type: 'job', job: JSON.parse((e as MessageEvent<string>).data) as Job });
        });
      }

      source.addEventListener('notification.created', (e) => {
        const notification = JSON.parse((e as MessageEvent<string>).data) as AppNotification;
        if (!alerted.has(notification.id)) {
          alerted.add(notification.id);
          callbacksRef.current.onNewNotification(notification);
        }
        dispatch({ type: 'notification', notification });
      });
      source.addEventListener('notification.read', (e) => {
        dispatch({
          type: 'notification',
          notification: JSON.parse((e as MessageEvent<string>).data) as AppNotification,
        });
      });

      source.onerror = () => {
        if (closed) return;
        dispatch({ type: 'connection', connection: 'reconnecting' });
        // EventSource retries on its own unless the server refused the connection outright.
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          retry = setTimeout(connect, 3000);
        }
      };
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      source?.close();
    };
  }, []);

  return state;
}
