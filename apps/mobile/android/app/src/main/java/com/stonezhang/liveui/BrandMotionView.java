package com.stonezhang.liveui;

import android.animation.ValueAnimator;
import android.content.Context;
import android.database.ContentObserver;
import android.graphics.*;
import android.graphics.drawable.Drawable;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.View;
import android.view.animation.LinearInterpolator;

/** Brand motion, never a percentage or a claim about network progress. */
final class BrandMotionView extends View {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Drawable mark;
    private ValueAnimator animator;
    private float phase;
    private boolean active = true, watching;
    private final ContentObserver motionSetting = new ContentObserver(new Handler(Looper.getMainLooper())) {
        @Override public void onChange(boolean selfChange) { updateMotion(); }
    };
    BrandMotionView(Context context) {
        super(context); mark = context.getDrawable(R.drawable.liveui_icon);
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
    }
    void setActive(boolean value) { active = value; updateMotion(); }
    boolean motionRunning() { return animator != null && animator.isRunning(); }
    float motionPhase() { return phase; }
    private void updateMotion() {
        boolean run = active && isAttachedToWindow() && getWindowVisibility() == VISIBLE && isShown() && ValueAnimator.areAnimatorsEnabled();
        if (!run) { if (animator != null) { animator.cancel(); animator = null; } phase = 0; invalidate(); return; }
        if (animator != null) return;
        animator = ValueAnimator.ofFloat(0, 1); animator.setDuration(3200); animator.setRepeatCount(ValueAnimator.INFINITE); animator.setInterpolator(new LinearInterpolator());
        animator.addUpdateListener(a -> { phase = (float)a.getAnimatedValue(); invalidate(); }); animator.start();
    }
    @Override protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        getContext().getContentResolver().registerContentObserver(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, motionSetting); watching = true; updateMotion();
    }
    @Override protected void onDetachedFromWindow() {
        if (watching) { getContext().getContentResolver().unregisterContentObserver(motionSetting); watching = false; }
        if (animator != null) { animator.cancel(); animator = null; } super.onDetachedFromWindow();
    }
    @Override protected void onWindowVisibilityChanged(int visibility) { super.onWindowVisibilityChanged(visibility); updateMotion(); }
    @Override protected void onVisibilityChanged(View changed, int visibility) { super.onVisibilityChanged(changed, visibility); updateMotion(); }
    @Override protected void onDraw(Canvas c) {
        super.onDraw(c);
        float size = Math.min(getWidth(), getHeight()), cx = getWidth()/2f, cy = getHeight()/2f, r = size*.40f;
        float pulse = (float)Math.sin(phase * Math.PI * 2), scale = 1 + .025f*pulse;
        paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(Math.max(1, size*.006f)); paint.setColor(0xffe6e6e2);
        c.drawCircle(cx, cy, r, paint);
        if (active) {
            paint.setStrokeCap(Paint.Cap.ROUND); paint.setColor(0xffa5a5a0);
            c.drawArc(cx-r,cy-r,cx+r,cy+r,phase*360-90,38,false,paint);
            double angle=(phase*360-90)*Math.PI/180;
            paint.setStyle(Paint.Style.FILL); paint.setColor(0xff171717);
            c.drawCircle(cx+r*(float)Math.cos(angle),cy+r*(float)Math.sin(angle),size*.019f,paint);
        }
        int half=Math.round(size*.25f*scale); mark.setBounds(Math.round(cx)-half, Math.round(cy)-half, Math.round(cx)+half, Math.round(cy)+half); mark.draw(c);
    }
}
