import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type StoredFile } from '../api';
import { Dock } from '../components/Dock';
import { Header } from '../components/Header';
import { Icon } from '../components/Icon';
import s from './ListScreen.module.scss';

export function PrepHomeScreen() {
    const navigate = useNavigate();
    const [files, setFiles] = useState<StoredFile[] | null>(null);

    useEffect(() => {
        api.listFiles()
            .then((all) =>
                setFiles(all.filter((f) => f.kind !== 'image' && (f.status ?? 'ready') === 'ready'))
            )
            .catch(() => setFiles([]));
    }, []);

    return (
        <div className={s.page}>
            <Header />
            <main className={s.body}>
                <h1>Prep</h1>
                <p className={s.lead}>
                    Pick a file from your library. Florence writes questions from its pages, at 1
                    token per question.
                </p>
                {files === null && <p className={s.lead}>Loading…</p>}
                {files?.length === 0 && (
                    <p className={s.lead}>No PDFs ready yet. Add one in Library first.</p>
                )}
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
                            onClick={() =>
                                navigate(`/prep/new?file=${encodeURIComponent(file.id)}`)
                            }
                        >
                            Practise
                        </button>
                    </div>
                ))}
            </main>
            <Dock />
        </div>
    );
}
