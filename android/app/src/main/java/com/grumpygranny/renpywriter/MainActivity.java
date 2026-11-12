package com.grumpygranny.renpywriter;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugin: files and git for the shared code.
        registerPlugin(RwHostPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
