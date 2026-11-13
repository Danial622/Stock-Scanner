// functions/api/trigger-scan.js
export async function onRequestPost(context) {
  const { env } = context;
  
  // Ensure the environment variable exists
  if (!env.GITHUB_PAT) {
    return new Response(JSON.stringify({ ok: false, error: 'Server missing GITHUB_PAT secret' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  const repo = "Danial622/Stock-Scanner";
  const workflowId = "score.yml";

  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflowId}/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_PAT}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Cloudflare-Pages'
      },
      body: JSON.stringify({ ref: 'main' }) // Triggers the workflow on the main branch
    });

    if (response.ok) {
      return new Response(JSON.stringify({ ok: true, message: 'Scan triggered successfully' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } else {
      const err = await response.text();
      return new Response(JSON.stringify({ ok: false, error: `GitHub API Error: ${response.status} ${err}` }), {
        status: response.status, headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
