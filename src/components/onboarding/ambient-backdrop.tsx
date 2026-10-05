import * as styles from './ambient-backdrop.css';

export function AmbientBackdrop() {
    return (
        <div className={styles.root} aria-hidden='true'>
            <div className={styles.far} />
            <div className={styles.near} />
        </div>
    );
}
