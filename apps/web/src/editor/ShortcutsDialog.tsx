import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { IconButton } from '../components/Button';
import styles from './ShortcutsDialog.module.css';

const GROUPS: ReadonlyArray<{ title: string; keys: ReadonlyArray<[string, string]> }> = [
  {
    title: 'Playback',
    keys: [
      ['Space', 'Play or pause'],
      ['← →', 'Step one frame'],
      ['⇧← ⇧→', 'Step one second'],
      ['↑ ↓', 'Previous or next cut'],
      ['Home End', 'Start or end'],
    ],
  },
  {
    title: 'Editing',
    keys: [
      ['S', 'Split at the playhead'],
      ['⌫', 'Delete'],
      ['⇧⌫', 'Ripple delete'],
      ['C', 'Add a caption'],
      ['⌘Z', 'Undo'],
      ['⇧⌘Z', 'Redo'],
      ['⌘A', 'Select everything'],
      ['Esc', 'Clear the selection'],
    ],
  },
  {
    title: 'Timeline',
    keys: [
      ['+ −', 'Zoom'],
      ['⇧Z', 'Fit to window'],
      ['N', 'Snapping on or off'],
      ['⌘ scroll', 'Zoom at the pointer'],
    ],
  },
  {
    title: 'Agent',
    keys: [
      ['/', 'Ask the agent'],
      ['Enter', 'Send'],
      ['⇧Enter', 'New line'],
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-label="Keyboard shortcuts"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current?.close();
      }}
    >
      <header className={styles.header}>
        <h2>Keyboard shortcuts</h2>
        <IconButton icon={X} label="Close" tipSide="left" onClick={() => dialog.current?.close()} />
      </header>
      <div className={styles.groups}>
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h3>{group.title}</h3>
            <dl>
              {group.keys.map(([keys, action]) => (
                <div key={keys} className={styles.row}>
                  <dt>{action}</dt>
                  <dd>
                    <kbd>{keys}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </dialog>
  );
}
