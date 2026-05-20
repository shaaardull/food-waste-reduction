import { Capture } from '../components/Capture';
import { useParams } from 'react-router-dom';

export function AfterCapture() {
  const { id = '' } = useParams();
  return (
    <Capture
      sessionId={id}
      phase="after"
      title="After photo"
      blurb="Snap your plates the way they are right now. A server will review the picture next."
      nextPath={`/sessions/${id}`}
      cta="Submit for review"
    />
  );
}
