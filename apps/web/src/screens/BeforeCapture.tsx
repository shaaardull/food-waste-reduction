import { useTranslation } from 'react-i18next';
import { Capture } from '../components/Capture';
import { useParams } from 'react-router-dom';

export function BeforeCapture() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  return (
    <Capture
      sessionId={id}
      phase="before"
      title={t('capture.before_title')}
      blurb={t('capture.before_blurb')}
      nextPath={`/sessions/${id}`}
      cta={t('capture.before_cta')}
    />
  );
}
