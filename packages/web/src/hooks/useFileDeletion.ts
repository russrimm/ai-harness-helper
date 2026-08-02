/**
 * One deletion state machine, shared by every view that offers a delete.
 *
 * Three views need exactly the same sequence — arm, confirm, report — and each
 * one keeping its own copy is how they end up disagreeing about whether a
 * failed delete clears the confirmation. It also keeps the outcome visible
 * after the list behind it reloads, because the backup path in the success
 * message is the only record the user has of where the file went.
 */

import { useCallback, useState } from 'react';
import { deleteFile } from '../api/client.js';
import { deleteRefusalMessage } from '../components/DeleteControl.js';
import { describeError } from './useAsync.js';

export interface DeleteNotice {
  readonly kind: 'ok' | 'error';
  readonly message: string;
}

export interface FileDeletion {
  /** File whose confirmation is open, if any. */
  readonly confirmingId: string | undefined;
  /** File currently being deleted, if any. */
  readonly busyId: string | undefined;
  readonly notice: DeleteNotice | undefined;
  readonly request: (fileId: string) => void;
  readonly cancel: () => void;
  readonly confirm: (fileId: string, label: string, expectedHash?: string) => void;
  readonly dismissNotice: () => void;
}

/**
 * @param onDeleted Called after a successful delete so the view can refresh
 * its list and drop any selection pointing at the file that is now gone.
 */
export function useFileDeletion(onDeleted?: (fileId: string) => void): FileDeletion {
  const [confirmingId, setConfirmingId] = useState<string | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<DeleteNotice | undefined>(undefined);

  const request = useCallback((fileId: string) => {
    setNotice(undefined);
    setConfirmingId(fileId);
  }, []);

  const cancel = useCallback(() => setConfirmingId(undefined), []);
  const dismissNotice = useCallback(() => setNotice(undefined), []);

  const confirm = useCallback(
    (fileId: string, label: string, expectedHash?: string) => {
      setBusyId(fileId);
      void (async () => {
        try {
          const outcome = await deleteFile(fileId, expectedHash);
          if (outcome.ok) {
            setConfirmingId(undefined);
            setNotice({
              kind: 'ok',
              message: `Deleted “${label}”. The previous contents are backed up to ${outcome.backupPath}.`,
            });
            onDeleted?.(fileId);
          } else {
            // The confirmation stays open on failure: every refusal here is
            // something the user can act on and retry.
            setNotice({ kind: 'error', message: deleteRefusalMessage(outcome) });
          }
        } catch (caught) {
          setNotice({ kind: 'error', message: describeError(caught) });
        } finally {
          setBusyId(undefined);
        }
      })();
    },
    [onDeleted],
  );

  return { confirmingId, busyId, notice, request, cancel, confirm, dismissNotice };
}
