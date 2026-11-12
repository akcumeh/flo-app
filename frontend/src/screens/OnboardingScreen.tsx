import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, client, uploadFiles } from '../api';
import { Icon, type IconName } from '../components/Icon';
import { Button, useToast } from '../components/ui';
import { useAccount } from '../state/AccountContext';
import s from './Onboarding.module.scss';

const LEVELS = [100, 200, 300, 400, 500, 600, 700];
const STEPS = 5;

function message(err: unknown, fallback: string): string {
    return err instanceof ApiError || err instanceof Error ? err.message : fallback;
}

function Progress({ step }: { step: number }) {
    return (
        <div
            className={s.dots}
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={STEPS}
            aria-valuenow={step}
            aria-label={`Step ${step} of ${STEPS}`}
        >
            {Array.from({ length: STEPS }, (_, i) => (
                <span
                    key={i}
                    className={
                        i + 1 === step
                            ? `${s.dot} ${s.dotOn}`
                            : i + 1 < step
                              ? `${s.dot} ${s.dotDone}`
                              : s.dot
                    }
                />
            ))}
        </div>
    );
}

function useDebounced<T>(value: T, ms = 250): T {
    const [v, setV] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setV(value), ms);
        return () => clearTimeout(t);
    }, [value, ms]);
    return v;
}

function SchoolStep({
    initial,
    onDone,
}: {
    initial: string | null;
    onDone: (schoolId: string, name: string) => Promise<void>;
}) {
    const [q, setQ] = useState('');
    const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const query = useDebounced(q.trim());
    const schools = useQuery({
        queryKey: ['schools', query],
        queryFn: async () =>
            (
                await client.GET('/v1/schools', {
                    params: { query: { q: query || undefined, limit: 30 } },
                })
            ).data!.items,
    });
    const selectedId = picked?.id ?? initial;

    return (
        <>
            <h1 className={s.title}>Where do you study?</h1>
            <label className={s.search}>
                <Icon name="search" />
                <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search universities"
                    aria-label="Search universities"
                />
            </label>
            <div className={s.list} role="radiogroup" aria-label="Schools">
                {(schools.data ?? []).map((school) => (
                    <button
                        key={school.id}
                        type="button"
                        role="radio"
                        aria-checked={school.id === selectedId}
                        className={
                            school.id === selectedId ? `${s.option} ${s.optionOn}` : s.option
                        }
                        onClick={() => setPicked({ id: school.id, name: school.name })}
                    >
                        <span className={s.check} aria-hidden="true">
                            {school.id === selectedId ? <Icon name="check-small" /> : null}
                        </span>
                        {school.name}
                    </button>
                ))}
                {schools.data?.length === 0 ? (
                    <p className={s.lead}>
                        No school matches "{query}". Check the spelling or try the short name.
                    </p>
                ) : null}
            </div>
            {error ? (
                <p className={s.error} role="alert">
                    {error}
                </p>
            ) : null}
            <div className={s.footer}>
                <Button
                    block
                    disabled={!selectedId}
                    loading={busy}
                    onClick={async () => {
                        if (!selectedId) return;
                        setBusy(true);
                        setError(null);
                        try {
                            await onDone(selectedId, picked?.name ?? '');
                        } catch (err) {
                            setError(message(err, 'Could not save your school.'));
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    Continue
                </Button>
            </div>
        </>
    );
}

function StudyStep({
    schoolId,
    initialDepartment,
    initialLevel,
    onDone,
}: {
    schoolId: string;
    initialDepartment: string;
    initialLevel: number | null;
    onDone: (body: {
        departmentId?: string;
        departmentName?: string;
        level: number;
    }) => Promise<void>;
}) {
    const [dept, setDept] = useState(initialDepartment);
    const [level, setLevel] = useState<number | null>(initialLevel);
    const [focused, setFocused] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const departments = useQuery({
        queryKey: ['departments', schoolId],
        queryFn: async () =>
            (
                await client.GET('/v1/schools/{schoolId}/departments', {
                    params: { path: { schoolId } },
                })
            ).data!.items,
    });
    const typed = dept.trim().toLowerCase();
    const exact = departments.data?.find((d) => d.name.toLowerCase() === typed);
    const matches = typed
        ? (departments.data ?? [])
              .filter((d) => d.name.toLowerCase().includes(typed) && d.name.toLowerCase() !== typed)
              .slice(0, 5)
        : [];

    return (
        <>
            <h1 className={s.title}>What are you studying?</h1>
            <div className={s.field}>
                <label htmlFor="department" className={s.label}>
                    Department
                </label>
                <input
                    id="department"
                    className={s.input}
                    value={dept}
                    autoComplete="off"
                    onChange={(e) => setDept(e.target.value)}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setTimeout(() => setFocused(false), 150)}
                    placeholder="Microbiology"
                />
                {focused && matches.length > 0 ? (
                    <div className={s.suggest} role="listbox" aria-label="Departments">
                        {matches.map((d) => (
                            <button
                                key={d.id}
                                type="button"
                                role="option"
                                aria-selected={false}
                                className={s.suggestItem}
                                onClick={() => setDept(d.name)}
                            >
                                {d.name}
                            </button>
                        ))}
                    </div>
                ) : null}
            </div>
            <p className={s.label}>Level</p>
            <div className={s.levels} role="radiogroup" aria-label="Level">
                {LEVELS.map((l) => (
                    <button
                        key={l}
                        type="button"
                        role="radio"
                        aria-checked={level === l}
                        className={level === l ? `${s.chip} ${s.chipOn}` : s.chip}
                        onClick={() => setLevel(l)}
                    >
                        {level === l ? <Icon name="check-small" /> : null}
                        {l}L
                    </button>
                ))}
            </div>
            {error ? (
                <p className={s.error} role="alert">
                    {error}
                </p>
            ) : null}
            <div className={s.footer}>
                <Button
                    block
                    disabled={dept.trim().length < 2 || !level}
                    loading={busy}
                    onClick={async () => {
                        if (!level) return;
                        setBusy(true);
                        setError(null);
                        try {
                            await onDone(
                                exact
                                    ? { departmentId: exact.id, level }
                                    : { departmentName: dept.trim(), level }
                            );
                        } catch (err) {
                            setError(message(err, 'Could not save your department.'));
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    Continue
                </Button>
            </div>
        </>
    );
}

function CoursesStep({ onDone }: { onDone: () => void }) {
    const qc = useQueryClient();
    const courses = useQuery({
        queryKey: ['courses'],
        queryFn: async () => (await client.GET('/v1/me/courses')).data!.items,
    });
    const [adding, setAdding] = useState(false);
    const [code, setCode] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const input = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (adding) input.current?.focus();
    }, [adding]);

    const add = async (e: FormEvent) => {
        e.preventDefault();
        if (code.trim().length < 2) return;
        setBusy(true);
        setError(null);
        try {
            await client.POST('/v1/me/courses', { body: { code: code.trim() } });
            setCode('');
            await qc.invalidateQueries({ queryKey: ['courses'] });
        } catch (err) {
            setError(message(err, 'Could not add that course.'));
        } finally {
            setBusy(false);
        }
    };

    const remove = async (courseId: string) => {
        try {
            await client.DELETE('/v1/me/courses/{courseId}', { params: { path: { courseId } } });
            await qc.invalidateQueries({ queryKey: ['courses'] });
        } catch (err) {
            setError(message(err, 'Could not remove that course.'));
        }
    };

    const items = courses.data ?? [];
    return (
        <>
            <h1 className={s.title}>Pick this semester's courses</h1>
            <p className={s.lead}>
                Add each course code, like BIO 201. You can change these later.
            </p>
            <div className={s.chips}>
                {items.map((e) => (
                    <button
                        key={e.course.id}
                        type="button"
                        className={`${s.chip} ${s.chipOn}`}
                        aria-label={`Remove ${e.course.code}`}
                        onClick={() => void remove(e.course.id)}
                    >
                        <Icon name="check-small" />
                        {e.course.code}
                    </button>
                ))}
                {adding ? (
                    <form onSubmit={add} className={s.addForm}>
                        <input
                            ref={input}
                            className={s.chipInput}
                            value={code}
                            onChange={(e) => setCode(e.target.value.toUpperCase())}
                            placeholder="BIO 201"
                            aria-label="Course code"
                            maxLength={16}
                            enterKeyHint="done"
                        />
                        <Button
                            type="submit"
                            size="small"
                            loading={busy}
                            disabled={code.trim().length < 2}
                        >
                            Add
                        </Button>
                    </form>
                ) : (
                    <button
                        type="button"
                        className={`${s.chip} ${s.chipDashed}`}
                        onClick={() => setAdding(true)}
                    >
                        + Add a course code
                    </button>
                )}
            </div>
            <p className={s.count}>{items.length} selected</p>
            {error ? (
                <p className={s.error} role="alert">
                    {error}
                </p>
            ) : null}
            <div className={s.footer}>
                <Button block onClick={onDone}>
                    Continue
                </Button>
            </div>
        </>
    );
}

function ExamStep({
    initial,
    onDone,
}: {
    initial: string | null;
    onDone: (date: string | null) => Promise<void>;
}) {
    const [date, setDate] = useState(initial ?? '');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const today = new Date().toISOString().slice(0, 10);
    const save = async (value: string | null) => {
        setBusy(true);
        setError(null);
        try {
            await onDone(value);
        } catch (err) {
            setError(message(err, 'Could not save the date.'));
        } finally {
            setBusy(false);
        }
    };
    return (
        <>
            <h1 className={s.title}>When's your first exam?</h1>
            <p className={s.lead}>We'll count down to it and suggest a mock exam in exam week.</p>
            <div className={s.field}>
                <label htmlFor="exam" className={s.label}>
                    First exam
                </label>
                <input
                    id="exam"
                    type="date"
                    className={s.input}
                    min={today}
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                />
            </div>
            <p className={s.hand}>not sure yet? skip it.</p>
            {error ? (
                <p className={s.error} role="alert">
                    {error}
                </p>
            ) : null}
            <div className={s.footer}>
                <Button block disabled={!date} loading={busy} onClick={() => void save(date)}>
                    Continue
                </Button>
                <Button variant="link" block onClick={() => void save(null)}>
                    Skip for now
                </Button>
            </div>
        </>
    );
}

function NotesStep({ onDone }: { onDone: (uploaded: boolean) => void }) {
    const toast = useToast();
    const fileInput = useRef<HTMLInputElement>(null);
    const photoInput = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const upload = async (list: FileList | null) => {
        if (!list || list.length === 0) return;
        setBusy(true);
        setError(null);
        try {
            await uploadFiles([...list]);
            toast('Florence is reading your notes. Questions will be ready in about a minute.');
            onDone(true);
        } catch (err) {
            setError(message(err, 'Could not upload that file.'));
        } finally {
            setBusy(false);
        }
    };

    const options: Array<{ icon: IconName; title: string; body: string; pick: () => void }> = [
        {
            icon: 'doc',
            title: 'Upload a file',
            body: 'PDF, up to 20 MB',
            pick: () => fileInput.current?.click(),
        },
        {
            icon: 'camera',
            title: 'Take photos of your notes',
            body: 'Handwritten is fine. Several pages at once.',
            pick: () => photoInput.current?.click(),
        },
    ];

    return (
        <>
            <h1 className={s.title}>Last step: add your notes</h1>
            <p className={s.lead}>
                Florence reads them and writes practice questions. Your notes stay private to you.
            </p>
            <div className={s.list}>
                {options.map((o) => (
                    <button
                        key={o.title}
                        type="button"
                        className={s.card}
                        onClick={o.pick}
                        disabled={busy}
                    >
                        <span className={s.cardIcon}>
                            <Icon name={o.icon} />
                        </span>
                        <span className={s.cardText}>
                            <span className={s.cardTitle}>{o.title}</span>
                            <span className={s.cardBody}>{o.body}</span>
                        </span>
                        <Icon name="chevron" className={s.chevron} />
                    </button>
                ))}
            </div>
            <input
                ref={fileInput}
                type="file"
                accept="application/pdf"
                hidden
                onChange={(e) => void upload(e.target.files)}
            />
            <input
                ref={photoInput}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                hidden
                onChange={(e) => void upload(e.target.files)}
            />
            {busy ? (
                <p className={s.lead} aria-live="polite">
                    Uploading
                </p>
            ) : null}
            {error ? (
                <p className={s.error} role="alert">
                    {error}
                </p>
            ) : null}
            <p className={s.or}>or</p>
            <Button variant="secondary" block onClick={() => onDone(false)} disabled={busy}>
                Skip for now
            </Button>
        </>
    );
}

export function OnboardingScreen() {
    const navigate = useNavigate();
    const { account, reload } = useAccount();
    const profile = account?.profile;
    const firstStep = !profile?.school ? 1 : !profile.department || !profile.level ? 2 : 3;
    const [step, setStep] = useState(firstStep);
    const [schoolId, setSchoolId] = useState<string | null>(profile?.school?.id ?? null);

    const save = async (body: Record<string, unknown>) => {
        await client.PUT('/v1/me/profile', { body: body as never });
        await reload();
    };

    const back = () => (step === 1 ? navigate(-1) : setStep(step - 1));

    return (
        <div className={s.page}>
            <header className={s.bar}>
                <button type="button" className={s.back} aria-label="Back" onClick={back}>
                    <Icon name="arrow-left" />
                </button>
            </header>
            <main className={s.body}>
                <Progress step={step} />
                {step === 1 ? (
                    <SchoolStep
                        initial={schoolId}
                        onDone={async (id) => {
                            await save({ schoolId: id });
                            setSchoolId(id);
                            setStep(2);
                        }}
                    />
                ) : null}
                {step === 2 && schoolId ? (
                    <StudyStep
                        schoolId={schoolId}
                        initialDepartment={profile?.department?.name ?? ''}
                        initialLevel={profile?.level ?? null}
                        onDone={async (body) => {
                            await save(body);
                            setStep(3);
                        }}
                    />
                ) : null}
                {step === 3 ? <CoursesStep onDone={() => setStep(4)} /> : null}
                {step === 4 ? (
                    <ExamStep
                        initial={profile?.examDate ?? null}
                        onDone={async (date) => {
                            if (date) await save({ examDate: date });
                            setStep(5);
                        }}
                    />
                ) : null}
                {step === 5 ? (
                    <NotesStep
                        onDone={() =>
                            navigate('/home', { replace: true, state: { askReminders: true } })
                        }
                    />
                ) : null}
            </main>
        </div>
    );
}
