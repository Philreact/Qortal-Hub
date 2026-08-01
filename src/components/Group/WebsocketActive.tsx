import { useEffect, useRef } from 'react';
import {
  getBaseApiReactSocket,
  pauseAllQueues,
  resumeAllQueues,
} from '../../App';
import { subscribeToEvent, unsubscribeFromEvent } from '../../utils/events';
import { useAtomValue } from 'jotai';
import { extStateAtom, selectedNodeInfoAtom } from '../../atoms/global';

export const WebSocketActive = ({ myAddress, setIsLoadingGroups }) => {
  const extState = useAtomValue(extStateAtom);
  const selectedNode = useAtomValue(selectedNodeInfoAtom);
  const extStateRef = useRef(extState);
  extStateRef.current = extState;
  const myAddressRef = useRef(myAddress);
  myAddressRef.current = myAddress;

  const socketRef = useRef(null); // WebSocket reference
  const connectionIdRef = useRef(0);
  const timeoutIdRef = useRef(null); // Timeout ID reference
  const groupSocketTimeoutRef = useRef(null); // Group Socket Timeout reference
  const reconnectTimeoutRef = useRef(null);
  const initiateRef = useRef(null);
  const forceCloseWebSocket = () => {
    connectionIdRef.current += 1;
    clearTimeout(timeoutIdRef.current);
    clearTimeout(groupSocketTimeoutRef.current);
    clearTimeout(reconnectTimeoutRef.current);
    timeoutIdRef.current = null;
    groupSocketTimeoutRef.current = null;
    reconnectTimeoutRef.current = null;
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      socket.close(1000, 'forced');
    }
  };

  const logoutEventFunc = () => {
    forceCloseWebSocket();
  };

  useEffect(() => {
    subscribeToEvent('logout-event', logoutEventFunc);

    return () => {
      unsubscribeFromEvent('logout-event', logoutEventFunc);
    };
  }, []);

  useEffect(() => {
    if (!myAddress || extState === 'not-authenticated') return; // Only proceed when authenticated with address

    let effectActive = true;

    const pingHeads = (
      socket: WebSocket,
      isCurrentConnection: (socket?: WebSocket | null) => boolean
    ) => {
      try {
        if (
          isCurrentConnection(socket) &&
          socket.readyState === WebSocket.OPEN
        ) {
          socket.send('ping');
          timeoutIdRef.current = setTimeout(() => {
            timeoutIdRef.current = null;
            if (isCurrentConnection(socket)) {
              socket.close();
              clearTimeout(groupSocketTimeoutRef.current);
              groupSocketTimeoutRef.current = null;
            }
          }, 5000); // Close if no pong in 5 seconds
        }
      } catch (error) {
        console.error('Error during ping:', error);
      }
    };

    const initWebsocketMessageGroup = async () => {
      forceCloseWebSocket(); // Ensure we close any existing connection
      const connectionId = connectionIdRef.current;
      const isCurrentConnection = (socket?: WebSocket | null) => {
        if (!effectActive || connectionIdRef.current !== connectionId) {
          return false;
        }
        if (socket && socketRef.current !== socket) return false;
        return true;
      };
      if (!isCurrentConnection()) return;
      const currentAddress = myAddress;
      if (extStateRef.current === 'not-authenticated') return;
      if (currentAddress !== myAddressRef.current) return;
      try {
        if (!initiateRef.current) {
          setIsLoadingGroups(true);
          pauseAllQueues();
        }
        const socketLink = `${getBaseApiReactSocket()}/websockets/chat/active/${currentAddress}?encoding=BASE64&haschatreference=false`;
        const socket = new WebSocket(socketLink);
        socketRef.current = socket;

        socket.onopen = () => {
          if (!isCurrentConnection(socket)) {
            socket.close(1000, 'superseded');
            return;
          }
          groupSocketTimeoutRef.current = setTimeout(
            () => pingHeads(socket, isCurrentConnection),
            50
          ); // Initial ping
        };

        socket.onmessage = (e) => {
          if (!isCurrentConnection(socket)) return;
          try {
            if (e.data === 'pong') {
              clearTimeout(timeoutIdRef.current);
              timeoutIdRef.current = null;
              groupSocketTimeoutRef.current = setTimeout(
                () => pingHeads(socket, isCurrentConnection),
                20000
              ); // Ping every 20 seconds
            } else {
              if (!initiateRef.current) {
                setIsLoadingGroups(false);
                initiateRef.current = true;
                resumeAllQueues();
              }
              const data = JSON.parse(e.data);
              const copyGroups = [...(data?.groups || [])];
              const findIndex = copyGroups?.findIndex(
                (item) => item?.groupId === 0
              );
              if (findIndex !== -1) {
                copyGroups[findIndex] = {
                  ...(copyGroups[findIndex] || {}),
                  groupId: '0',
                };
              }
              const filteredGroups = copyGroups;
              const sortedGroups = filteredGroups.sort(
                (a, b) => (b.timestamp || 0) - (a.timestamp || 0)
              );
              const sortedDirects = (data?.direct || [])
                .filter(
                  (item) =>
                    item?.name !== 'extension-proxy' &&
                    item?.address !== 'QSMMGSgysEuqDCuLw3S4cHrQkBrh3vP3VH'
                )
                .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

              window
                .sendMessage('handleActiveGroupDataFromSocket', {
                  groups: sortedGroups,
                  directs: sortedDirects,
                })
                .catch((error) => {
                  console.error(
                    'Failed to handle active group data from socket:',
                    error.message || 'An error occurred'
                  );
                });
            }
          } catch (error) {
            console.error('Error parsing onmessage data:', error);
          }
        };

        socket.onclose = (event) => {
          if (!isCurrentConnection(socket)) return;
          socketRef.current = null;
          clearTimeout(groupSocketTimeoutRef.current);
          clearTimeout(timeoutIdRef.current);
          groupSocketTimeoutRef.current = null;
          timeoutIdRef.current = null;
          console.warn(`WebSocket closed: ${event.reason || 'unknown reason'}`);
          if (extStateRef.current === 'not-authenticated') return; // Don't retry after logout
          if (event.reason !== 'forced' && event.code !== 1000) {
            reconnectTimeoutRef.current = setTimeout(() => {
              reconnectTimeoutRef.current = null;
              if (isCurrentConnection()) {
                void initWebsocketMessageGroup();
              }
            }, 10000); // Retry after 10 seconds
          }
        };

        socket.onerror = (error) => {
          if (!isCurrentConnection(socket)) return;
          console.error('WebSocket error:', error);
          clearTimeout(groupSocketTimeoutRef.current);
          clearTimeout(timeoutIdRef.current);
          groupSocketTimeoutRef.current = null;
          timeoutIdRef.current = null;
          socket.close();
        };
      } catch (error) {
        console.error('Error initializing WebSocket:', error);
      }
    };

    void initWebsocketMessageGroup(); // Initialize WebSocket on component mount

    return () => {
      effectActive = false;
      forceCloseWebSocket(); // Clean up WebSocket on component unmount
    };
  }, [myAddress, extState, selectedNode?.apikey, selectedNode?.url]);

  return null;
};
