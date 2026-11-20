import styles from "./Toolbar.module.css";

export function Toolbar() {
  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Order actions">
      <button type="button">Refresh</button>
      <button type="button">Export</button>
      <button type="button">Share</button>
    </div>
  );
}
