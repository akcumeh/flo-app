import { useEffect, useState } from 'react';
import { api, type StoredFile } from '../api';
import { Dock } from '../components/Dock';
import { Header } from '../components/Header';
import { Icon } from '../components/Icon';
import s from './ListScreen.module.scss';

export function LibraryScreen() {
    const [files, setFiles] = useState<StoredFile[] | null>(null);

    useEffect(() => {
        api.listFiles().then(setFiles);
    }, []);

    return (
        <div className={s.page}>
            <Header />
            <main className={s.body}>
                <h1>Library</h1>
                <p className={s.lead}>
                    Files Florence can use. Up to 20, PDF or image, 20 MB each.
                </p>
                {files === null && <p className={s.lead}>Loading…</p>}
                {files?.map((file) => (
                    <div key={file.id} className={s.row}>
                        <span className={s.fileIcon}>
                            <Icon name="doc" />
                        </span>
                        <span className={s.rowText}>
                            <span className={s.name}>{file.name}</span>
                            <span className={s.meta}>{Math.round(file.sizeBytes / 1024)} KB</span>
                        </span>
                    </div>
                ))}
            </main>
            <Dock />
        </div>
    );
}
