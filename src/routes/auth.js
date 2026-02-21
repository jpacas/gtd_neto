import express from 'express';

export function createAuthRoutes({ USE_SUPABASE, supabaseAuth, APP_URL, sanitizeInput, authCookieOptions, clearAuthCookieOptions, clearCsrfCookieOptions, authLimiter, renderPage }) {
    const router = express.Router();

    router.get('/login', async (req, res) => {
        if (!USE_SUPABASE) return res.redirect('/');
        if (req.auth?.user) return res.redirect('/');
        return renderPage(res, 'login', {
            title: 'Login',
            needApiKey: false,
            message: String(req.query?.message || ''),
            hideAppNav: true,
        });
    });

    router.get('/signup', async (req, res) => {
        if (!USE_SUPABASE) return res.redirect('/');
        if (req.auth?.user) return res.redirect('/');
        return renderPage(res, 'signup', { title: 'Registro', needApiKey: false, hideAppNav: true });
    });

    router.post('/auth/login', authLimiter, async (req, res) => {
        if (!USE_SUPABASE || !supabaseAuth) return res.redirect('/');

        const email = sanitizeInput(String(req.body?.email || '').trim());

        // SECURITY: Validate email format before sending to Supabase
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return renderPage(res, 'login', {
                title: 'Login',
                flash: { error: 'Formato de email inválido.' },
                needApiKey: false,
                hideAppNav: true,
            });
        }

        const password = String(req.body?.password || ''); // No sanitizar password

        const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
        if (error || !data?.session) {
            return renderPage(res, 'login', {
                title: 'Login',
                flash: { error: 'Credenciales inválidas.' },
                needApiKey: false,
                hideAppNav: true,
            });
        }

        res.cookie('sb_access_token', data.session.access_token, authCookieOptions());
        res.cookie('sb_refresh_token', data.session.refresh_token, authCookieOptions());
        return res.redirect('/');
    });

    router.post('/auth/signup', authLimiter, async (req, res) => {
        if (!USE_SUPABASE || !supabaseAuth) return res.redirect('/');

        const email = sanitizeInput(String(req.body?.email || '').trim());

        // SECURITY: Validate email format before sending to Supabase
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return renderPage(res, 'signup', {
                title: 'Registro',
                flash: { error: 'Formato de email inválido.' },
                needApiKey: false,
                hideAppNav: true,
            });
        }

        const password = String(req.body?.password || ''); // No sanitizar password

        const { error } = await supabaseAuth.auth.signUp({ email, password });
        if (error) {
            return renderPage(res, 'signup', {
                title: 'Registro',
                flash: { error: error.message || 'No se pudo crear la cuenta.' },
                needApiKey: false,
                hideAppNav: true,
            });
        }

        return res.redirect('/login?message=Cuenta creada. Revisa tu correo para confirmación si aplica.');
    });

    router.post('/auth/forgot', authLimiter, async (req, res) => {
        if (!USE_SUPABASE || !supabaseAuth) return res.redirect('/');

        const email = sanitizeInput(String(req.body?.email || '').trim());
        if (!email) return res.redirect('/login?message=Ingresa tu correo para recuperar contraseña.');

        // SECURITY: Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.redirect('/login?message=Formato de email inválido.');
        }

        // SECURITY: Use APP_URL instead of req.get('host') to prevent SSRF attacks
        if (!APP_URL) {
            console.error('[auth/forgot] APP_URL not configured - cannot send password reset');
            return res.redirect('/login?message=Error de configuración. Contacta al administrador.');
        }

        const redirectTo = `${APP_URL}/login?message=Contraseña actualizada. Ya puedes iniciar sesión.`;
        await supabaseAuth.auth.resetPasswordForEmail(email, { redirectTo });
        return res.redirect('/login?message=Si el correo existe, enviamos enlace de recuperación.');
    });

    router.post('/auth/logout', (req, res) => {
        res.clearCookie('sb_access_token', clearAuthCookieOptions());
        res.clearCookie('sb_refresh_token', clearAuthCookieOptions());
        res.clearCookie('csrf_token', clearCsrfCookieOptions());
        return res.redirect('/login');
    });

    return router;
}
