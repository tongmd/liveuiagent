package com.stonezhang.liveui;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.graphics.drawable.StateListDrawable;
import android.widget.Button;

final class NativeStyle {
    static final int PAPER = 0xfffafaf8, INK = 0xff171717;
    static int dp(Context c, int value) { return Math.round(value*c.getResources().getDisplayMetrics().density); }
    static GradientDrawable rounded(Context c, int color, int radius) {
        GradientDrawable shape=new GradientDrawable(); shape.setColor(color); shape.setCornerRadius(dp(c,radius)); return shape;
    }
    static Button button(Context c, String title, boolean primary) {
        Button b=new Button(c); b.setText(title); b.setAllCaps(false); b.setTextSize(15); b.setMinWidth(0); b.setMinimumWidth(0);
        b.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); b.setMinHeight(dp(c,48)); b.setMinimumHeight(dp(c,48)); b.setPadding(dp(c,16),0,dp(c,16),0);
        b.setStateListAnimator(null); b.setElevation(0); b.setTranslationZ(0); b.setBackgroundTintList(null);
        StateListDrawable colors=new StateListDrawable(); colors.addState(new int[]{-android.R.attr.state_enabled},rounded(c,0xffeeeeeb,18)); colors.addState(new int[]{},rounded(c,primary?INK:0xffffffff,18));
        b.setBackground(new RippleDrawable(ColorStateList.valueOf(primary?0x33ffffff:0x14000000),colors,rounded(c,0xffffffff,18)));
        b.setTextColor(new ColorStateList(new int[][]{new int[]{-android.R.attr.state_enabled},new int[]{}},new int[]{0xff92928e,primary?0xffffffff:INK})); return b;
    }
}
