import styles from "./Toolbar.module.css";

export function Toolbar() {
  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Text formatting">
      {["Bold", "Italic", "Underline", "Link", "Align"].map((label) => (
        <button key={label} type="button" className={styles.button}>
          {label}
        </button>
      ))}
    </div>
  );
}
