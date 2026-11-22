import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api, type StoredFile } from '../api';
import { Dock } from '../components/Dock';
import { Header } from '../components/Header';
import { Icon } from '../components/Icon';
import { isOutOfTokens, useOutOfTokens } from '../components/OutOfTokens';
import s from './ListScreen.module.scss';

export function PrepHomeScreen() {
    const navigate = useNavigate();
    const [files, setFiles] = useState<StoredFile[] | null>(null);
    const [starting, setStarting] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const outOfTokens = useOutOfTokens();

    useEffect(() => {
        api.listFiles()
            .then((all) =>
                setFiles(all.filter((f) => f.kind !== 'image' && (f.status ?? 'ready') === 'ready'))
            )
            .catch(() => setFiles([]));
    }, []);

    const start = async (file: StoredFile) => {
        setStarting(file.id);
        setError(null);
        try {
            const session = await api.createPrepSession([file.id], 10);
            navigate(`/prep/${session.id}`);
        } catch (err) {
            if (isOutOfTokens(err)) outOfTokens({ what: 'A prep session', cost: 1 });
            else
                setError(
                    err instanceof ApiError ? err.message : 'Could not start a session. Try again.'
                );
        } finally {
            setStarting(null);
        }
    };

    return (
        <div className={s.page}>
            <Header />
            <main className={s.body}>
                <h1>Prep</h1>
                <p className={s.lead}>
                    Pick a file from your library. Florence writes questions from its pages.
                </p>
                {files === null && <p className={s.lead}>Loading…</p>}
                {files?.length === 0 && (
                    <p className={s.lead}>No PDFs ready yet. Add one in Library first.</p>
                )}
                {error ? (
                    <p className={s.lead} role="alert">
                        {error}
                    </p>
                ) : null}
                {files?.map((file) => (
                    <div key={file.id} className={s.row}>
                        <span className={s.fileIcon}>
                            <Icon name="doc" />
                        </span>
                        <span className={s.rowText}>
                            <span className={s.name}>{file.name}</span>
                            <span className={s.meta}>{Math.round(file.sizeBytes / 1024)} KB</span>
                        </span>
                        <button
                            type="button"
                            className={s.action}
                            onClick={() => start(file)}
                            disabled={starting !== null}
                        >
                            {starting === file.id ? 'Starting…' : 'Start quiz'}
                        </button>
                    </div>
                ))}
            </main>
            <Dock />
        </div>
    );
}
