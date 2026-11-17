import { Outlet } from 'react-router-dom';
import { useAuth } from '../../auth';
import { Icon } from '../../icons';
import { Button, Card, useAction } from '../../ui';

/**
 * Everything under /college runs inside <CollegeArea/>. Until the university head approves the college
 * (and again if they suspend it) the dashboards would only return ORG_NOT_ACTIVE, so show a clear
 * waiting screen instead.
 */
const COPY = {
  pending: ['Waiting for your university', 'Your college has been registered and is waiting for approval by the University Head. You can use the dashboard as soon as it is approved — you will be notified.'],
  rejected: ['Registration was declined', 'The University Head declined this college registration. Contact the university for details.'],
  suspended: ['College suspended', 'The University Head has suspended this college. Instructors and students are blocked until it is reactivated.'],
  none: ['No college linked', 'Your account is not linked to a college yet. Contact the university.'],
};

function Gate({ status }) {
  const { context, refresh } = useAuth();
  const [run, busy] = useAction();
  const [title, text] = COPY[status] || COPY.none;
  return (
    <div className="mx-auto max-w-xl pt-6">
      <Card>
        <div className="flex size-12 items-center justify-center rounded-2xl bg-warn-soft text-warn"><Icon name="shield" className="size-6" /></div>
        <h1 className="mt-4 text-xl font-semibold tracking-tight">{title}</h1>
        {context?.college?.name && <p className="mt-1 text-sm font-medium">{context.college.name}{context.university ? <span className="text-muted"> · {context.university}</span> : null}</p>}
        <p className="mt-2 text-sm text-muted">{text}</p>
        <Button className="mt-5" variant="secondary" busy={busy} onClick={() => run(refresh)}>Check status</Button>
      </Card>
    </div>
  );
}

export function CollegeArea() {
  const { context } = useAuth();
  return context?.status === 'active' ? <Outlet /> : <Gate status={context?.status} />;
}
