// The one WebSocket connection, reachable from any component.
//
// App owns the connection (useSocket) and provides it here; Terminal and
// FilePanel read it instead of threading send/onMessage/status through
// props. The hook throws outside a provider so a missing one is a loud
// error at mount, not a silent no-op socket.

import { createContext, useContext } from 'react'
import type { UseSocketReturn } from './hooks/useSocket'

const SocketContext = createContext<UseSocketReturn | null>(null)

export const SocketProvider = SocketContext.Provider

export function useSocketContext(): UseSocketReturn {
  const socket = useContext(SocketContext)
  if (!socket) throw new Error('useSocketContext must be used inside a SocketProvider')
  return socket
}
